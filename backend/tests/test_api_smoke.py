import os
import sys
from fastapi.testclient import TestClient

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Ensure relative DB_PATH ("problems.db") resolves inside backend/
os.chdir(BACKEND_DIR)

import main  # noqa: E402

client = TestClient(main.app)

EXPECTED_CATEGORIES = {
    "Algorithms",
    "Data Structures",
    "Off-by-One",
    "Edge Cases",
    "Type Coercion",
    "Memory & State",
    "Concurrency",
}


def test_health_root():
    resp = client.get("/")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("status") == "OK"


def test_categories_all_seven_and_nonzero():
    resp = client.get("/categories")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("total", 0) > 0
    names = {c["name"] for c in data.get("categories", [])}
    assert EXPECTED_CATEGORIES.issubset(names)


def test_problems_list_deduplicated_with_tags_and_test_count():
    resp = client.get("/problems?limit=5000")
    assert resp.status_code == 200
    data = resp.json()
    problems = data.get("problems", [])
    assert len(problems) > 0

    ids = [p["id"] for p in problems]
    assert len(ids) == len(set(ids)), "Duplicate problem IDs returned in /problems"

    sample = problems[0]
    assert "tags" in sample and isinstance(sample["tags"], list)
    assert "test_count" in sample and isinstance(sample["test_count"], int)


def test_problem_detail_strips_hidden_test_cases():
    resp = client.get("/problems/1")
    assert resp.status_code == 200
    data = resp.json()
    assert "test_cases" in data
    assert len(data["test_cases"]) <= 1
    assert data.get("test_count", 0) >= 1


def test_profile_requires_jwt():
    resp = client.get("/profile/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 401


def test_submit_patch_rate_limit_429(monkeypatch):
    # Reset rate bucket for clean deterministic test & stub auth/evaluate_patch
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()

    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": "00000000-0000-0000-0000-000000000001", "username": "Tester"},
    )
    monkeypatch.setattr(
        main,
        "evaluate_patch",
        lambda **kwargs: {"passed": False, "message": "Stubbed evaluation"},
    )

    headers = {"Authorization": "Bearer test-token"}
    payload = {
        "problem_id": 1,
        "user_code": "print('test')",
        "language": "python",
    }

    first = client.post("/submit-patch", json=payload, headers=headers)
    assert first.status_code == 200

    second = client.post("/submit-patch", json=payload, headers=headers)
    assert second.status_code == 429


def test_responses_include_utf8_charset():
    health_resp = client.get("/health")
    assert health_resp.status_code == 200
    assert "charset=utf-8" in health_resp.headers.get("content-type", "").lower()

    unauth_resp = client.get("/profile/00000000-0000-0000-0000-000000000000")
    assert unauth_resp.status_code == 401
    assert "charset=utf-8" in unauth_resp.headers.get("content-type", "").lower()

    svg_resp = client.get("/badge/unknown_tester_utf8.svg")
    assert svg_resp.status_code == 200
    svg_ct = svg_resp.headers.get("content-type", "").lower()
    assert "image/svg+xml" in svg_ct and "charset=utf-8" in svg_ct


def test_api_users_public_profile_bundle(monkeypatch):
    import database as db

    uid = "00000000-0000-0000-0000-000000000099"
    today_ist, _ = db.get_ist_today_yesterday()

    monkeypatch.setattr(
        db,
        "_lookup_public_user_row",
        lambda ident: {
            "id": uid,
            "username": "Patel Yug",
            "score": 268,
            "streak": 2,
            "solves": 2,
            "tier": "free",
        }
        if ident in (uid, "Patel Yug")
        else None,
    )
    monkeypatch.setattr(db, "_compute_user_global_rank", lambda user_id, user_score: (2, 1420))
    monkeypatch.setattr(
        db,
        "fetch_user_solve_history",
        lambda user_id, access_token=None, limit=2000: [
            {"problem_id": 1, "best_points": 140, "best_grade": "Surgical", "solved_at": f"{today_ist}T10:15:00Z"},
            {"problem_id": 2, "best_points": 128, "best_grade": "Refactor", "solved_at": f"{today_ist}T09:00:00Z"},
        ],
    )

    resp = client.get(f"/api/users/{uid}/public-profile")
    assert resp.status_code == 200
    data = resp.json()

    assert data["profile"]["display_name"] == "Patel Yug"
    assert data["profile"]["initials"] == "PY"
    assert data["profile"]["rank"] == 2
    assert data["profile"]["score"] == 268
    assert data["profile"]["solved_count"] >= 2
    assert data["profile"]["total_problems"] > 0

    assert set(data["breakdown"]["difficulty"].keys()) == {"Very Easy", "Easy", "Medium", "Hard"}
    assert isinstance(data["breakdown"]["categories"], list)
    assert data["activity"]["weeks"] == 12
    assert len(data["activity"]["days"]) == 84
    assert len(data["solved_challenges"]) == 2
    assert {"id", "title", "category", "difficulty", "solved_at"}.issubset(data["solved_challenges"][0].keys())

    not_found = client.get("/api/users/00000000-0000-0000-0000-000000000404/public-profile")
    assert not_found.status_code == 404


def test_problem_payload_strips_python_comments_safely():
    import io
    import tokenize

    sample_with_strings = (
        "def parse_hex(tag):\n"
        "    # Bug: fails to normalize '#fff' hex strings\n"
        "    # Fix: check prefix before stripping\n"
        "    # Fixed: strip('#')\n"
        "    # Hint: try normalize\n"
        "    # Iterate through characters safely\n"
        '    color = "#ff00ff"\n'
        "    return tag.strip('#') if color else ''  # inline spoiler\n"
    )
    cleaned = main._strip_python_comments(sample_with_strings, "python")
    for marker in ("# Bug:", "# Fix:", "# Fixed:", "# Hint:", "# Iterate", "# inline spoiler"):
        assert marker not in cleaned
    assert '"#ff00ff"' in cleaned
    assert "tag.strip('#')" in cleaned
    compile(cleaned, "<string>", "exec")
    for tok in tokenize.generate_tokens(io.StringIO(cleaned).readline):
        assert tok.type != tokenize.COMMENT

    for pid in (1, 4, 6):
        resp = client.get(f"/problems/{pid}")
        assert resp.status_code == 200
        body = resp.json()
        buggy_code = body.get("buggy_code", "")
        assert buggy_code
        compile(buggy_code, "<string>", "exec")
        for tok in tokenize.generate_tokens(io.StringIO(buggy_code).readline):
            assert tok.type != tokenize.COMMENT, f"Problem {pid} leaked comment token: {tok.string}"


def test_validate_minimal_patch_allows_bug_fix_and_rejects_rewrite():
    import runner

    starter = (
        "import sys\n"
        "def solve():\n"
        "    n_str = sys.stdin.read().strip()\n"
        "    if not n_str:\n"
        "        return\n"
        "    n = int(n_str)\n"
        "    current_sum = sum(range(1, n))\n"
        "    print(current_sum)\n"
        "if __name__ == '__main__':\n"
        "    solve()\n"
    )
    minimal_fix = starter.replace("sum(range(1, n))", "sum(range(1, n + 1))")
    ok_res = runner.validate_minimal_patch(starter, minimal_fix)
    assert ok_res["valid"] is True
    assert ok_res["changed_lines"] == 1
    assert ok_res["max_allowed_changes"] >= 3
    assert ok_res["similarity"] >= 0.55

    # Comments and blank lines alone must not evade rewrite rejection
    full_rewrite = (
        "# Totally new solution\n\n"
        "def compute_fast(num):\n"
        "    return num * (num + 1) // 2\n\n"
        "val = int(input().strip())\n"
        "print(compute_fast(val))\n"
    )
    bad_res = runner.validate_minimal_patch(starter, full_rewrite)
    assert bad_res["valid"] is False
    assert bad_res["reason"] == "rewrite_detected"
    assert "Rewrite detected (" in bad_res["message"]
    assert "LintIQ requires patching the existing buggy code rather than rewriting from scratch." in bad_res["message"]

    # Deleting all starter code must be rejected immediately
    empty_res = runner.validate_minimal_patch(starter, "")
    assert empty_res["valid"] is False
    assert empty_res["reason"] == "rewrite_detected"

    # Syntax error in small patch skips AST check gracefully so normal SyntaxError feedback runs
    typo_patch = starter.replace("sum(range(1, n))", "sum(range(1, n + 1)")
    typo_res = runner.validate_minimal_patch(starter, typo_patch)
    assert typo_res["valid"] is True


def test_submit_patch_rejects_full_rewrite_even_with_correct_output(monkeypatch):
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()

    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": "00000000-0000-0000-0000-000000000077", "username": "RewriteTester"},
    )
    eval_called = {"count": 0}

    def _stub_eval(**kwargs):
        eval_called["count"] += 1
        return {"passed": True, "message": "All Passed"}

    monkeypatch.setattr(main, "evaluate_patch", _stub_eval)
    monkeypatch.setattr(main, "record_user_solve", lambda **kwargs: {"score": 999, "points_earned": 100})

    # Complete rewrite producing exact output for problem 1
    rewritten_solution = "n = int(input().strip())\nprint(n * (n + 1) // 2)\n"
    reject_resp = client.post(
        "/submit-patch",
        json={"problem_id": 1, "user_code": rewritten_solution, "language": "python"},
        headers={"Authorization": "Bearer valid-mock-token"},
    )
    assert reject_resp.status_code == 200
    reject_data = reject_resp.json()
    assert reject_data["passed"] is False
    assert reject_data["rejected_reason"] == "rewrite_detected"
    assert "Rewrite detected (" in reject_data["message"]
    assert "profile" not in reject_data
    assert eval_called["count"] == 0

    # Clear bucket and verify legitimate 1-line fix reaches evaluate_patch cleanly
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()
    prob1 = client.get("/problems/1").json()
    patched_code = prob1["buggy_code"].replace("range(1, n)", "range(1, n + 1)")
    pass_resp = client.post(
        "/submit-patch",
        json={"problem_id": 1, "user_code": patched_code, "language": "python"},
        headers={"Authorization": "Bearer valid-mock-token"},
    )
    assert pass_resp.status_code == 200
    pass_data = pass_resp.json()
    assert pass_data["passed"] is True
    assert eval_called["count"] == 1


def test_practice_and_interview_dual_catalogs(monkeypatch):
    import io
    import tokenize

    # Practice mode: 1,652 distinct problems (including 100 Very Easy) from problems.db
    prac_list = client.get("/problems?mode=practice&limit=5000")
    assert prac_list.status_code == 200
    prac_data = prac_list.json()
    assert prac_data["total"] == 1652
    assert len(prac_data["problems"]) == 1652
    very_easy_prac = [p for p in prac_data["problems"] if p["difficulty"] == "Very Easy"]
    assert len(very_easy_prac) == 100

    # Verify difficulty sort places Very Easy -> Easy -> Medium -> Hard
    sorted_list = client.get("/problems?mode=practice&sort=difficulty&limit=5000")
    assert sorted_list.status_code == 200
    rank_map = {"Very Easy": 0, "Easy": 1, "Medium": 2, "Hard": 3}
    ranks = [rank_map[p["difficulty"]] for p in sorted_list.json()["problems"]]
    assert ranks == sorted(ranks)

    # Interview mode: 750 problems (250 Easy, 250 Medium, 250 Hard) from interview_problems.db
    int_list = client.get("/problems?mode=interview&limit=5000")
    assert int_list.status_code == 200
    int_data = int_list.json()
    assert int_data["total"] == 750
    assert len(int_data["problems"]) == 750

    diff_counts = {"Easy": 0, "Medium": 0, "Hard": 0}
    for p in int_data["problems"]:
        diff_counts[p["difficulty"]] = diff_counts.get(p["difficulty"], 0) + 1
    assert diff_counts == {"Easy": 250, "Medium": 250, "Hard": 250}

    int_cats = client.get("/categories?mode=interview")
    assert int_cats.status_code == 200
    assert int_cats.json()["total"] == 750

    # Problem #1 differs between Practice and Interview and strips all # comments
    prac_p1 = client.get("/problems/1?mode=practice")
    int_p1 = client.get("/problems/1?mode=interview")
    assert prac_p1.status_code == 200
    assert int_p1.status_code == 200
    prac_body = prac_p1.json()
    int_body = int_p1.json()
    assert int_body["title"] != prac_body["title"]
    assert int_body["title"] == "DFS Path Existence"

    buggy_code = int_body.get("buggy_code", "")
    assert buggy_code
    compile(buggy_code, "<string>", "exec")
    for tok in tokenize.generate_tokens(io.StringIO(buggy_code).readline):
        assert tok.type != tokenize.COMMENT, f"Interview problem #1 leaked comment: {tok.string}"

    # Verify /submit-patch routes to interview_problems.db when mode='interview'
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": "00000000-0000-0000-0000-000000000088", "username": "InterviewTester"},
    )
    eval_calls = {"count": 0}
    monkeypatch.setattr(
        main,
        "evaluate_patch",
        lambda **kwargs: eval_calls.__setitem__("count", eval_calls["count"] + 1) or {"passed": True, "message": "All Passed"},
    )
    monkeypatch.setattr(main, "record_user_solve", lambda **kwargs: {"score": 100, "points_earned": 100})

    # Submitting Practice #1 code against Interview #1 must be rejected as rewrite_detected
    wrong_catalog = client.post(
        "/submit-patch",
        json={"problem_id": 1, "user_code": prac_body["buggy_code"], "language": "python", "mode": "interview"},
        headers={"Authorization": "Bearer valid-mock-token"},
    )
    assert wrong_catalog.status_code == 200
    assert wrong_catalog.json()["passed"] is False
    assert wrong_catalog.json()["rejected_reason"] == "rewrite_detected"
    assert eval_calls["count"] == 0



