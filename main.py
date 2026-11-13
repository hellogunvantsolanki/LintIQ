from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from schemas import SubmitPatchRequest, HintRequest
from database import (
    init_db,
    fetch_categories_summary,
    fetch_random_problem,
    fetch_problem_test_cases,
    fetch_problem_hint,
    fetch_user_profile,
    record_user_solve,
    reset_user_streak,
    fetch_top_leaderboard,
)
from runner import evaluate_patch
from ai_generator import generate_ai_bug_challenge

app = FastAPI(title="LintIQ API", version="1.4.0")

# Enable Cross-Origin Resource Sharing for local & production frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://lint-iq.vercel.app",
        "https://lint-iq.vercel.app/",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize and auto-migrate database on startup
init_db()

# Queue and cache for AI-generated challenges
_pending_ai_problem: Optional[Dict[str, Any]] = None
_ai_problems_cache: Dict[int, Dict[str, Any]] = {}


@app.get("/")
def root():
    return {"status": "ok", "service": "LintIQ Engine", "version": "1.4.0"}


@app.get("/categories")
def get_categories():
    return fetch_categories_summary()


@app.get("/get-problem")
def get_problem(
    category: Optional[str] = Query(None, description="Filter by problem domain category"),
    difficulty: Optional[str] = Query(None, description="Filter by Easy, Medium, or Hard"),
    exclude_id: Optional[int] = Query(None, description="Exclude current problem ID to avoid immediate repeats"),
):
    global _pending_ai_problem
    if _pending_ai_problem is not None:
        problem = _pending_ai_problem
        _pending_ai_problem = None
        return problem

    problem = fetch_random_problem(
        category=category,
        difficulty=difficulty,
        exclude_id=exclude_id,
    )
    if not problem:
        raise HTTPException(
            status_code=404,
            detail="No challenges match the selected category and difficulty filter.",
        )
    return problem


@app.post("/generate-ai-problem")
def create_ai_problem(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
):
    global _pending_ai_problem
    try:
        problem = generate_ai_bug_challenge(category=category, difficulty=difficulty)
        _pending_ai_problem = problem
        if problem and "id" in problem:
            _ai_problems_cache[int(problem["id"])] = problem
        return problem
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/submit-patch")
def submit_patch(payload: SubmitPatchRequest):
    test_cases = payload.test_cases
    if not test_cases and payload.problem_id:
        test_cases = fetch_problem_test_cases(payload.problem_id)
        if not test_cases and payload.problem_id in _ai_problems_cache:
            test_cases = _ai_problems_cache[payload.problem_id].get("test_cases", [])

    result = evaluate_patch(
        user_code=payload.user_code,
        test_cases=test_cases or [],
        language=getattr(payload, "language", "python") or "python",
    )

    if result["passed"]:
        if payload.user_id:
            profile = record_user_solve(
                user_id=payload.user_id,
                username=payload.username,
                time_seconds=payload.time_seconds or 0,
                access_token=payload.access_token,
            )
            if profile:
                result["profile"] = profile
    else:
        if payload.user_id:
            reset_user_streak(
                user_id=payload.user_id,
                username=payload.username,
                access_token=payload.access_token,
            )

    return result


@app.post("/get-hint")
def get_hint(payload: HintRequest):
    if payload.problem_id:
        hint = fetch_problem_hint(payload.problem_id)
        if not hint and payload.problem_id in _ai_problems_cache:
            hint = _ai_problems_cache[payload.problem_id].get("hint")
        if hint:
            return {"hint": hint}

    return {"hint": "Examine variable boundaries, data types, and how loops handle edge conditions."}


@app.get("/profile/{user_id}")
def get_user_profile(user_id: str):
    profile = fetch_user_profile(user_id=user_id)
    if not profile:
        return {
            "id": user_id,
            "score": 0,
            "streak": 0,
            "solves": 0,
            "tier": "free",
        }
    return profile


@app.get("/leaderboard")
def get_leaderboard():
    return fetch_top_leaderboard(limit=10)