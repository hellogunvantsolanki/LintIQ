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
