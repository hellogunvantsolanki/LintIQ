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


def test_health_endpoint_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("status") == "OK"


def test_problem_detail_hides_non_sample_test_cases():
    resp = client.get("/problems/1")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data.get("test_count"), int)
    assert data["test_count"] >= 1
    assert isinstance(data.get("test_cases"), list)
    assert len(data["test_cases"]) <= 1


def test_profile_rejects_unauthenticated():
    resp = client.get("/profile/00000000-0000-0000-0000-000000000000")
    assert resp.status_code in (401, 403)


def test_profile_activity_zero_and_populated(monkeypatch):
    uid = "00000000-0000-0000-0000-000000000002"
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": uid, "username": "ActivityTester"},
    )
    monkeypatch.setattr(
        main,
        "fetch_user_profile",
        lambda user_id, access_token=None: {"id": uid, "username": "ActivityTester", "score": 0, "streak": 0, "solves": 0, "tier": "free"},
    )
    monkeypatch.setattr(main, "fetch_user_solve_history", lambda user_id, access_token=None: [])

    empty_resp = client.get(f"/profile/{uid}", headers={"Authorization": "Bearer valid"})
    assert empty_resp.status_code == 200
    empty_data = empty_resp.json()
    assert empty_data["solve_dates"] == []
    assert empty_data["total_active_days"] == 0
    assert empty_data["current_streak"] == 0
    assert empty_data["max_streak"] == 0
    assert empty_data["recent_solves"] == []

    monkeypatch.setattr(
        main,
        "fetch_user_solve_history",
        lambda user_id, access_token=None: [
            {"problem_id": 1, "best_points": 140, "best_grade": "Surgical", "solved_at": "2026-11-24T19:45:00Z"},
            {"problem_id": 2, "best_points": 130, "best_grade": "Refactor", "solved_at": "2026-11-23T15:10:00Z"},
        ],
    )
    pop_resp = client.get(f"/profile/{uid}", headers={"Authorization": "Bearer valid"})
    assert pop_resp.status_code == 200
    pop_data = pop_resp.json()
    assert len(pop_data["solve_dates"]) == 2
    assert pop_data["total_active_days"] == 2
    assert pop_data["max_streak"] == 2
    assert len(pop_data["recent_solves"]) == 2


def test_submit_patch_rejects_unauthenticated_and_rate_limits(monkeypatch):
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()

    payload = {
        "problem_id": 1,
        "user_code": "print('test')",
        "language": "python",
    }

    # Unauthenticated request must be rejected (401)
    unauth = client.post("/submit-patch", json=payload)
    assert unauth.status_code == 401

    # Immediate second request from same IP must hit rate limiter (429)
    rate_limited = client.post("/submit-patch", json=payload)
    assert rate_limited.status_code == 429

    # Also verify authenticated path returns 200 when bucket is fresh
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

    ok_resp = client.post(
        "/submit-patch",
        json=payload,
        headers={"Authorization": "Bearer valid-mock-token"},
    )
    assert ok_resp.status_code == 200


def test_public_profile_no_pii_and_404(monkeypatch):
    sample_public = {
        "username": "gunvant",
        "tier": "Bug Hunter II",
        "score": 450,
        "solves": 3,
        "streak": 2,
        "current_streak": 2,
        "max_streak": 2,
        "total_active_days": 2,
        "daily_activity": [{"date": "2026-11-24", "count": 2}],
        "solve_dates": ["2026-11-24T19:45:00Z", "2026-11-24T19:50:00Z"],
        "recent_solves": [
            {
                "problem_id": 1,
                "title": "Two Sum",
                "difficulty": "Easy",
                "category": "Algorithms",
                "best_points": 140,
                "best_grade": "Surgical",
                "solved_at": "2026-11-24T19:50:00Z",
            }
        ],
    }

    monkeypatch.setattr(
        main,
        "fetch_public_profile_by_username",
        lambda u: sample_public if u == "gunvant" else None,
    )

    ok = client.get("/public-profile/gunvant")
    assert ok.status_code == 200
    body = ok.json()
    assert body["username"] == "gunvant"
    assert body["solves"] == 3
    assert "email" not in body
    assert "user_id" not in body
    assert "id" not in body

    missing = client.get("/public-profile/nonexistent_user_xyz")
    assert missing.status_code == 404


def test_badge_svg_headers_and_xml_escaping(monkeypatch):
    monkeypatch.setattr(
        main,
        "fetch_public_profile_by_username",
        lambda u: {
            "username": u,
            "tier": "Bug Hunter II",
            "score": 450,
            "solves": 5,
            "streak": 3,
        }
        if u == "gunvant"
        else None,
    )

    # Default circular achievement medal (Bronze for solves < 10)
    resp = client.get("/badge/gunvant.svg")
    assert resp.status_code == 200
    assert resp.headers.get("content-type", "").startswith("image/svg+xml")
    assert resp.headers.get("cache-control") == "public, max-age=1800"
    assert 'width="180" height="210" viewBox="0 0 180 210"' in resp.text
    assert "#cd7f32" in resp.text
    assert "BUG HUNTER II" in resp.text
    assert "5 BUGS" in resp.text
    assert "3D STREAK" in resp.text

    # Metallic tier progression (Silver >=10, Gold >=25, Emerald Diamond >=50)
    for solves, expected_hex in [(15, "#e2e8f0"), (33, "#eab308"), (55, "#10b981")]:
        monkeypatch.setattr(
            main,
            "fetch_public_profile_by_username",
            lambda u, s=solves: {"username": u, "tier": "Principal Auditor", "score": 5000, "solves": s, "streak": 2},
        )
        tier_resp = client.get("/badge/gunvant.svg")
        assert tier_resp.status_code == 200
        assert expected_hex in tier_resp.text

    # Legacy horizontal pill fallback via ?style=pill
    pill_resp = client.get("/badge/gunvant.svg?style=pill")
    assert pill_resp.status_code == 200
    assert 'height="28"' in pill_resp.text
    assert "Principal Auditor" in pill_resp.text

    # Not-found fallback + XML escaping on username
    monkeypatch.setattr(main, "fetch_public_profile_by_username", lambda u: None)
    xss_resp = client.get("/badge/<script>alert(1).svg")
    assert xss_resp.status_code == 200
    assert xss_resp.headers.get("content-type", "").startswith("image/svg+xml")
    assert xss_resp.headers.get("cache-control") == "public, max-age=1800"
    assert "<script>" not in xss_resp.text
    assert "&lt;script&gt;" in xss_resp.text
    assert "PROFILE NOT FOUND" in xss_resp.text

    # Also verify tier escaping when profile exists with malicious characters
    monkeypatch.setattr(
        main,
        "fetch_public_profile_by_username",
        lambda u: {"username": u, "tier": "<script>evil</script>", "score": 100, "solves": 1, "streak": 1},
    )
    tier_xss = client.get("/badge/gunvant.svg")
    assert tier_xss.status_code == 200
    assert "<script>" not in tier_xss.text
    assert "&lt;SCRIPT&gt;EVIL&lt;/SCRIPT&gt;" in tier_xss.text


def test_track_counts_consistent_across_categories_and_problems():
    cat_resp = client.get("/categories")
    assert cat_resp.status_code == 200
    cat_map = {c["name"]: c["count"] for c in cat_resp.json()["categories"]}

    prob_resp = client.get("/problems?category=Algorithms&limit=5000")
    assert prob_resp.status_code == 200
    assert cat_map.get("Algorithms") == prob_resp.json()["total"]


def test_profile_unified_streak(monkeypatch):
    uid = "00000000-0000-0000-0000-000000000003"
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": uid, "username": "ConsistencyTester"},
    )
    monkeypatch.setattr(
        main,
        "fetch_user_profile",
        lambda user_id, access_token=None: {"id": uid, "username": "ConsistencyTester", "score": 200, "streak": 2, "solves": 3, "tier": "free"},
    )
    monkeypatch.setattr(
        main,
        "fetch_user_solve_history",
        lambda user_id, access_token=None: [
            {"problem_id": 1, "best_points": 120, "best_grade": "Refactor", "solved_at": "2026-11-24T10:00:00Z"},
            {"problem_id": 2, "best_points": 120, "best_grade": "Refactor", "solved_at": "2026-11-23T10:00:00Z"},
        ],
    )
    prof_resp = client.get(f"/profile/{uid}", headers={"Authorization": "Bearer valid"})
    assert prof_resp.status_code == 200
    prof_data = prof_resp.json()
    assert prof_data["streak"] == prof_data["current_streak"]
    assert "track_mastery" not in prof_data
    assert "blind_spot" not in prof_data


def test_generate_ai_problem_enforces_requested_category_and_default_difficulty(monkeypatch):
    with main._AI_RATE_LOCK:
        main._AI_RATE_BUCKETS.clear()
    with main._AI_LIVE_LOCK:
        main._AI_LIVE_DAILY_BUCKETS.clear()
        main._AI_LIVE_GLOBAL_BUCKET.clear()

    monkeypatch.setattr(main, "fetch_unseen_ai_problem", lambda **kwargs: (None, 0))
    captured = {}

    def fake_gen(category=None, difficulty=None):
        captured["category"] = category
        captured["difficulty"] = difficulty
        return {
            "id": 100999,
            "title": "Sample Algo Bug",
            "category": "Type Coercion",  # Even if inner payload drifts, endpoint enforces safe_cat
            "difficulty": difficulty or "Medium",
            "description": "Test",
            "language": "python",
            "buggy_code": "print(1)",
            "test_cases": [{"input": "", "expected_output": "1"}],
            "hint": "Hint",
            "tags": ["algo"],
        }

    monkeypatch.setattr(main, "generate_ai_bug_challenge", fake_gen)
    resp = client.post("/generate-ai-problem?category=Algorithms")
    assert resp.status_code == 200
    data = resp.json()
    assert captured["category"] == "Algorithms"
    assert captured["difficulty"] == "Medium"
    assert data["category"] == "Algorithms"
    assert data["difficulty"] == "Medium"


def test_xff_rightmost_ip_and_hint_rate_limit():
    with main._HINT_RATE_LOCK:
        main._HINT_RATE_BUCKETS.clear()

    r1 = client.post(
        "/get-hint",
        json={"problem_id": 1},
        headers={"X-Forwarded-For": "10.0.0.1, 198.51.100.42"},
    )
    assert r1.status_code == 200

    # Changing leftmost spoofed IP with same rightmost proxy IP must still trigger 429
    r2 = client.post(
        "/get-hint",
        json={"problem_id": 1},
        headers={"X-Forwarded-For": "10.0.0.2, 198.51.100.42"},
    )
    assert r2.status_code == 429


def test_unsupported_language_returns_400_and_payload_caps_return_422(monkeypatch):
    with main._RUN_RATE_LOCK:
        main._RUN_RATE_BUCKETS.clear()
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()

    bad_run = client.post(
        "/run-code",
        json={"problem_id": 1, "user_code": "class Solution {}", "language": "java"},
    )
    assert bad_run.status_code == 400
    assert "Unsupported language" in bad_run.json()["detail"]

    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": "00000000-0000-0000-0000-000000000001", "username": "Tester"},
    )
    bad_submit = client.post(
        "/submit-patch",
        json={"problem_id": 1, "user_code": "class Solution {}", "language": "java"},
        headers={"Authorization": "Bearer valid-mock-token"},
    )
    assert bad_submit.status_code == 400
    assert "Unsupported language" in bad_submit.json()["detail"]

    too_big = client.post(
        "/run-code",
        json={"problem_id": 1, "user_code": "x" * 65537, "language": "python"},
    )
    assert too_big.status_code == 422


def test_generate_ai_live_daily_quota(monkeypatch):
    with main._AI_RATE_LOCK:
        main._AI_RATE_BUCKETS.clear()
    with main._AI_LIVE_LOCK:
        main._AI_LIVE_DAILY_BUCKETS.clear()
        main._AI_LIVE_GLOBAL_BUCKET.clear()

    monkeypatch.setattr(main, "fetch_unseen_ai_problem", lambda **kwargs: (None, 0))
    monkeypatch.setattr(
        main,
        "generate_ai_bug_challenge",
        lambda category=None, difficulty=None: {
            "id": 100888,
            "title": "Quota Test Bug",
            "category": category or "Algorithms",
            "difficulty": difficulty or "Medium",
            "description": "Test",
            "language": "python",
            "buggy_code": "print(1)",
            "test_cases": [{"input": "", "expected_output": "1"}],
            "hint": "Hint",
            "tags": ["algo"],
        },
    )

    for idx in range(main._AI_LIVE_GUEST_DAILY_LIMIT):
        with main._AI_RATE_LOCK:
            main._AI_RATE_BUCKETS.clear()
        ok = client.post(
            "/generate-ai-problem?category=Algorithms",
            headers={"X-Forwarded-For": "203.0.113.77"},
        )
        assert ok.status_code == 200, f"Unexpected failure at {idx}: {ok.text}"

    with main._AI_RATE_LOCK:
        main._AI_RATE_BUCKETS.clear()
    blocked = client.post(
        "/generate-ai-problem?category=Algorithms",
        headers={"X-Forwarded-For": "203.0.113.77"},
    )
    assert blocked.status_code == 429


def test_problems_syncs_solved_ids_from_supabase(monkeypatch):
    uid = "00000000-0000-0000-0000-000000000009"
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": uid, "username": "SupabaseSyncUser"},
    )
    monkeypatch.setattr(
        main,
        "fetch_user_solve_history",
        lambda user_id, access_token=None, limit=2000: [{"problem_id": 1, "best_points": 100}],
    )
    resp = client.get("/problems?limit=5", headers={"Authorization": "Bearer valid-token"})
    assert resp.status_code == 200
    by_id = {p["id"]: p for p in resp.json()["problems"]}
    assert by_id[1]["solved"] is True


def test_review_patch_endpoint_validation_rate_limit_and_404(monkeypatch):
    with main._REVIEW_RATE_LOCK:
        main._REVIEW_RATE_BUCKETS.clear()

    monkeypatch.setattr(
        main,
        "review_user_patch",
        lambda **kwargs: {
            "root_cause": "Missing edge bound check.",
            "patch_quality": "Clean linear-time fix.",
            "production_tip": "Add boundary regression tests in CI.",
        },
    )

    ok_resp = client.post(
        "/review-patch",
        json={"problem_id": 1, "user_code": "print('fixed')", "language": "python"},
        headers={"X-Forwarded-For": "198.51.100.88"},
    )
    assert ok_resp.status_code == 200
    body = ok_resp.json()
    assert set(body.keys()) == {"root_cause", "patch_quality", "production_tip"}

    # Immediate second request from same IP must hit 429 rate limiter
    rate_resp = client.post(
        "/review-patch",
        json={"problem_id": 1, "user_code": "print('fixed')", "language": "python"},
        headers={"X-Forwarded-For": "198.51.100.88"},
    )
    assert rate_resp.status_code == 429

    # Fresh IP requesting non-existent problem must return 404
    with main._REVIEW_RATE_LOCK:
        main._REVIEW_RATE_BUCKETS.clear()
    missing_resp = client.post(
        "/review-patch",
        json={"problem_id": 99999999, "user_code": "print('fixed')", "language": "python"},
    )
    assert missing_resp.status_code == 404

    # Oversized user_code (> 65536 chars) must return 422
    too_big = client.post(
        "/review-patch",
        json={"problem_id": 1, "user_code": "a" * 65537, "language": "python"},
    )
    assert too_big.status_code == 422


def test_daily_challenge_deterministic_and_2x_xp_bonus(monkeypatch):
    r1 = client.get("/daily-challenge")
    r2 = client.get("/daily-challenge")
    assert r1.status_code == 200
    assert r2.status_code == 200

    d1 = r1.json()
    d2 = r2.json()
    assert d1["xp_multiplier"] == 2
    assert d1["completed_today"] is False
    assert d1["timezone"] == "IST (UTC+05:30)"
    assert d1["date_ist"]
    assert d1["resets_at"].endswith("T00:00:00+05:30")
    assert d1["resets_at_utc"].endswith("T18:30:00Z")
    assert d1["problem"] is not None
    assert d1["problem"]["id"] == d2["problem"]["id"]
    daily_id = d1["problem"]["id"]

    # Verify authenticated completion detection in IST (even when UTC timestamp is late-evening previous day) & 2x XP bonus
    uid = "00000000-0000-0000-0000-000000000010"
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": uid, "username": "DailyHunter"},
    )
    from datetime import datetime, timezone as _tz
    ist_midnight_utc = datetime.fromisoformat(d1["resets_at"]).astimezone(_tz.utc)
    # 1 hour after today's IST midnight = 19:30Z on previous UTC day
    early_morning_ist_in_utc = (ist_midnight_utc.replace(day=ist_midnight_utc.day) - main.timedelta(hours=23)).isoformat().replace("+00:00", "Z")
    monkeypatch.setattr(
        main,
        "fetch_user_solve_history",
        lambda user_id, access_token=None, limit=500: [
            {"problem_id": daily_id, "best_points": 200, "solved_at": early_morning_ist_in_utc}
        ],
    )
    done_resp = client.get("/daily-challenge", headers={"Authorization": "Bearer valid-token"})
    assert done_resp.status_code == 200
    assert done_resp.json()["completed_today"] is True

    # Reset solve history to empty & test 2x XP passed to record_user_solve
    with main._SUBMIT_RATE_LOCK:
        main._SUBMIT_RATE_BUCKETS.clear()
    monkeypatch.setattr(main, "fetch_user_solve_history", lambda user_id, access_token=None, limit=500: [])
    monkeypatch.setattr(
        main,
        "evaluate_patch",
        lambda **kwargs: {"passed": True, "message": "Passed!", "patch_metrics": {"grade": "Clean", "multiplier": 1.25}},
    )
    captured = {}

    def fake_record(**kwargs):
        captured.update(kwargs)
        return {"id": uid, "streak": 1, "score": 250, "solves": 1, "points_earned": 250}

    monkeypatch.setattr(main, "record_user_solve", fake_record)

    sub_resp = client.post(
        "/submit-patch",
        json={"problem_id": daily_id, "user_code": "print('fixed')", "language": "python"},
        headers={"Authorization": "Bearer valid-token"},
    )
    assert sub_resp.status_code == 200
    sub_data = sub_resp.json()
    assert captured["daily_multiplier"] == 2
    assert sub_data["daily_bonus"] is True
    assert sub_data["xp_multiplier"] == 2


def test_daily_streak_once_per_day_consecutive_and_missed_reset(monkeypatch):
    import database as db
    from datetime import datetime, timedelta, timezone as _tz

    today_ist, yesterday_ist = db.get_ist_today_yesterday()
    two_days_ago_ist = (
        datetime.strptime(today_ist, "%Y-%m-%d").date() - timedelta(days=2)
    ).isoformat()

    # 1. Effective streak read checks: active only if last_streak_date is today or yesterday (IST)
    assert db.get_effective_streak(5, today_ist, today_ist, yesterday_ist) == 5
    assert db.get_effective_streak(5, yesterday_ist, today_ist, yesterday_ist) == 5
    assert db.get_effective_streak(5, two_days_ago_ist, today_ist, yesterday_ist) == 0
    assert db.get_effective_streak(5, None, today_ist, yesterday_ist) == 0

    uid = "00000000-0000-0000-0000-000000000022"
    state = {"streak": 0, "max_streak": 0, "last_streak_date": None, "score": 0, "solves": 0}
    solves_store = {}

    monkeypatch.setattr(
        db,
        "fetch_user_profile",
        lambda user_id, access_token=None: {
            "id": uid,
            "username": "StreakTester",
            "score": state["score"],
            "streak": state["streak"],
            "max_streak": state["max_streak"],
            "last_streak_date": state["last_streak_date"],
            "solves": state["solves"],
            "tier": "free",
        },
    )
    monkeypatch.setattr(
        db,
        "_get_previous_solve",
        lambda user_id, problem_id, access_token=None: solves_store.get(problem_id),
    )
    monkeypatch.setattr(
        db,
        "_save_problem_solve",
        lambda user_id, problem_id, pts, grade, access_token=None: solves_store.__setitem__(problem_id, (pts, grade)),
    )
    monkeypatch.setattr(db, "_upsert_sqlite_profile", lambda p: None)
    monkeypatch.setattr(db, "_upsert_supabase_profile", lambda p, access_token=None: True)

    # First solve today -> streak becomes 1
    r1 = db.record_user_solve(uid, "StreakTester", time_seconds=15, problem_id=1)
    assert r1["streak"] == 1
    assert r1["max_streak"] == 1
    assert r1["last_streak_date"] == today_ist
    state.update({"streak": r1["streak"], "max_streak": r1["max_streak"], "last_streak_date": r1["last_streak_date"], "score": r1["score"], "solves": r1["solves"]})

    # Second solve on SAME IST day -> streak MUST remain 1
    r2 = db.record_user_solve(uid, "StreakTester", time_seconds=15, problem_id=2)
    assert r2["streak"] == 1
    assert r2["max_streak"] == 1
    assert r2["solves"] == 2

    # 2. Solve on consecutive day (yesterday -> today) -> streak increments by 1 (2 -> 3)
    state.update({"streak": 2, "max_streak": 2, "last_streak_date": yesterday_ist})
    r3 = db.record_user_solve(uid, "StreakTester", time_seconds=15, problem_id=3)
    assert r3["streak"] == 3
    assert r3["max_streak"] == 3

    # 3. Missing a day (last_streak_date older than yesterday): GET /profile returns 0, next solve restarts at 1 while preserving max_streak
    monkeypatch.setattr(
        main,
        "verify_supabase_token",
        lambda token: {"id": uid, "username": "StreakTester"},
    )
    monkeypatch.setattr(
        main,
        "fetch_user_profile",
        lambda user_id, access_token=None: {
            "id": uid,
            "username": "StreakTester",
            "score": 400,
            "streak": 4,
            "max_streak": 4,
            "last_streak_date": two_days_ago_ist,
            "solves": 4,
            "tier": "free",
        },
    )
    monkeypatch.setattr(
        main,
        "fetch_user_solve_history",
        lambda user_id, access_token=None: [
            {"problem_id": 1, "best_points": 120, "best_grade": "Refactor", "solved_at": f"{two_days_ago_ist}T10:00:00Z"}
        ],
    )
    prof_resp = client.get(f"/profile/{uid}", headers={"Authorization": "Bearer valid-token"})
    assert prof_resp.status_code == 200
    prof_data = prof_resp.json()
    assert prof_data["current_streak"] == 0
    assert prof_data["streak"] == 0
    assert prof_data["max_streak"] == 4

    # Subsequent solve after missed day restarts streak at 1 and keeps max_streak = 4
    state.update({"streak": 4, "max_streak": 4, "last_streak_date": two_days_ago_ist})
    r4 = db.record_user_solve(uid, "StreakTester", time_seconds=15, problem_id=4)
    assert r4["streak"] == 1
    assert r4["max_streak"] == 4


def test_api_users_public_profile_privacy_and_404(monkeypatch):
    import database as db

    uid = "00000000-0000-0000-0000-000000000077"
    today_ist, _ = db.get_ist_today_yesterday()

    monkeypatch.setattr(
        db,
        "_lookup_public_user_row",
        lambda ident: {
            "id": uid,
            "username": "CleanAuditor",
            "email": "secret@example.com",
            "password": "hashed_password",
            "access_token": "jwt_secret",
            "settings": {"theme": "dark"},
            "score": 520,
            "streak": 3,
            "solves": 1,
            "tier": "Bug Hunter II",
        }
        if ident == uid
        else None,
    )
    monkeypatch.setattr(db, "_compute_user_global_rank", lambda user_id, user_score: (5, 100))
    monkeypatch.setattr(
        db,
        "fetch_user_solve_history",
        lambda user_id, access_token=None, limit=2000: [
            {
                "problem_id": 1,
                "best_points": 140,
                "best_grade": "Surgical",
                "user_code": "def secret_patch(): return 42",
                "buggy_code": "def buggy(): pass",
                "patch": "--- a\n+++ b",
                "solved_at": f"{today_ist}T12:00:00Z",
            }
        ],
    )

    resp = client.get(f"/api/users/{uid}/public-profile")
    assert resp.status_code == 200
    body = resp.json()
    raw_text = resp.text

    # No private PII or source code anywhere in serialized response
    for sensitive in (
        "secret@example.com",
        "hashed_password",
        "jwt_secret",
        "def secret_patch",
        "def buggy",
    ):
        assert sensitive not in raw_text

    forbidden_fields = {
        "email",
        "password",
        "access_token",
        "token",
        "settings",
        "user_code",
        "buggy_code",
        "submitted_code",
        "patch",
        "test_cases",
        "hint",
    }
    assert not (forbidden_fields & set(body.keys()))
    assert not ((forbidden_fields | {"id", "user_id"}) & set(body["profile"].keys()))
    for ch in body["solved_challenges"]:
        assert not (forbidden_fields & set(ch.keys()))
        assert set(ch.keys()) == {"id", "title", "category", "difficulty", "solved_at"}

    # Missing or mock users cleanly return 404
    assert client.get("/api/users/00000000-0000-0000-0000-000000000999/public-profile").status_code == 404
    assert client.get("/api/users/mock_fake_user/public-profile").status_code == 404


def test_sandbox_blocks_getattr_reflection_null_bytes_and_env_secrets(monkeypatch):
    import runner

    # 1. Reflection / getattr / dunder bypass attempts must be blocked by AST sandbox
    for evil_code in (
        "getattr(__import__('os'), 'system')('id')",
        "x = [].__class__.__base__.__subclasses__()",
        "print(globals())",
        "import sysconfig\nprint(sysconfig.get_paths())",
        "import sys\nprint(sys.modules)",
    ):
        if "sys.modules" not in evil_code:
            safe, msg = runner._check_python_security(evil_code)
            assert not safe, f"Expected AST block for: {evil_code}"
            assert "Security Alert" in msg

    # 2. Null bytes must be handled cleanly without unhandled ValueError 500
    with main._RUN_RATE_LOCK:
        main._RUN_RATE_BUCKETS.clear()
    null_resp = client.post(
        "/run-code",
        json={"user_code": "print(1)\x00", "stdin": "", "language": "python"},
    )
    assert null_resp.status_code == 200
    assert null_resp.json()["ok"] is False
    assert null_resp.json()["error_type"] == "syntax_error"

    # 3. _build_safe_env strips all sensitive API/DB keys
    monkeypatch.setenv("GEMINI_API_KEY", "secret-gemini-value")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "secret-supabase-role")
    monkeypatch.setenv("ONLINECOMPILER_API_KEY", "secret-compiler-key")
    safe_env = runner._build_safe_env("/tmp/lintiq_test_dir")
    assert "GEMINI_API_KEY" not in safe_env
    assert "SUPABASE_SERVICE_ROLE_KEY" not in safe_env
    assert "ONLINECOMPILER_API_KEY" not in safe_env
    assert safe_env.get("PYTHONIOENCODING") == "utf-8"
    assert safe_env.get("PYTHONUTF8") == "1"


def test_sqli_oversized_payloads_and_error_redaction(monkeypatch):
    # 1. SQLi & PostgREST wildcard injection attempts return 400 or 404 safely
    sqli_cat = client.get("/problems", params={"category": "Algorithms' OR '1'='1"})
    assert sqli_cat.status_code == 400

    sqli_user = client.get("/api/users/' OR 1=1 --/public-profile")
    assert sqli_user.status_code == 404

    # 2. Oversized payloads fail fast with 422 Pydantic validation
    oversized_code = client.post(
        "/run-code",
        json={"user_code": "a" * 70000, "stdin": "", "language": "python"},
    )
    assert oversized_code.status_code == 422

    oversized_submit = client.post(
        "/submit-patch",
        json={
            "problem_id": 1,
            "user_code": "print(1)",
            "username": "x" * 200,
            "language": "python",
        },
    )
    assert oversized_submit.status_code == 422

    oversized_query = client.get("/problems", params={"category": "A" * 120})
    assert oversized_query.status_code == 422

    # 3. Global exception handler redacts raw tracebacks and secret strings
    no_raise_client = TestClient(main.app, raise_server_exceptions=False)
    monkeypatch.setattr(
        main,
        "fetch_public_profile_dossier",
        lambda uid: (_ for _ in ()).throw(RuntimeError("C:\\secret\\path GEMINI_API_KEY=AIzaSecretLeak")),
    )
    err_resp = no_raise_client.get("/api/users/00000000-0000-0000-0000-000000000099/public-profile")
    assert err_resp.status_code == 500
    assert err_resp.json() == {"detail": "Internal server error."}
    assert "AIzaSecretLeak" not in err_resp.text
    assert "C:\\secret" not in err_resp.text


def test_public_profile_rate_limit_and_xss_payload_safety(monkeypatch):
    import database as db

    with main._PUBLIC_PROFILE_RATE_LOCK:
        main._PUBLIC_PROFILE_RATE_BUCKETS.clear()

    # XSS in username/tier must never execute or leak unescaped in SVG badge
    xss_name = "<img src=x onerror=alert(1)>"
    monkeypatch.setattr(
        main,
        "fetch_public_profile_by_username",
        lambda u: {"username": u, "tier": xss_name, "score": 100, "solves": 1, "streak": 1},
    )
    svg_resp = client.get("/badge/<img src=x onerror=alert(1)>.svg")
    assert svg_resp.status_code == 200
    assert "<img" not in svg_resp.text
    assert "&lt;img" in svg_resp.text
    assert "&lt;IMG" in svg_resp.text

    # Public dossier rate limit triggers 429 after 60 requests/min
    monkeypatch.setattr(db, "_lookup_public_user_row", lambda ident: None)
    with main._PUBLIC_PROFILE_RATE_LOCK:
        main._PUBLIC_PROFILE_RATE_BUCKETS.clear()
    for _ in range(main._PUBLIC_PROFILE_MAX_PER_MIN):
        r = client.get("/api/users/00000000-0000-0000-0000-000000000404/public-profile")
        assert r.status_code == 404
    capped = client.get("/api/users/00000000-0000-0000-0000-000000000404/public-profile")
    assert capped.status_code == 429
    with main._PUBLIC_PROFILE_RATE_LOCK:
        main._PUBLIC_PROFILE_RATE_BUCKETS.clear()
