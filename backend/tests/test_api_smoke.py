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

    assert set(data["breakdown"]["difficulty"].keys()) == {"Easy", "Medium", "Hard"}
    assert isinstance(data["breakdown"]["categories"], list)
    assert data["activity"]["weeks"] == 12
    assert len(data["activity"]["days"]) == 84
    assert len(data["solved_challenges"]) == 2
    assert {"id", "title", "category", "difficulty", "solved_at"}.issubset(data["solved_challenges"][0].keys())

    not_found = client.get("/api/users/00000000-0000-0000-0000-000000000404/public-profile")
    assert not_found.status_code == 404

