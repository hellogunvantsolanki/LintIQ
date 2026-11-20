from datetime import datetime, timezone
from typing import Optional, Dict, Any
import logging
import sqlite3

from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def verify_token(authorization: Optional[str]) -> str:
    """Extract and validate the Bearer token from the Authorization header."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing access token")
    parts = authorization.split(" ", 1)
    token = parts[1].strip() if len(parts) == 2 else parts[0].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing access token")
    return token


def ensure_db_indexes() -> None:
    """Ensure SQLite indexes exist so 1,500+ problem queries stay sub-millisecond."""
    try:
        conn = sqlite3.connect("problems.db")
        cur = conn.cursor()
        cur.execute("CREATE INDEX IF NOT EXISTS idx_problems_cat_diff ON problems(category, difficulty)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_problems_diff ON problems(difficulty)")
        conn.commit()
        conn.close()
    except Exception as exc:
        logger.warning("Could not ensure DB indexes: %s", exc)


app = FastAPI(title="LintIQ API", version="1.4.0")

# Compress JSON responses for faster page & challenge loads
app.add_middleware(GZipMiddleware, minimum_size=500)

# Enable Cross-Origin Resource Sharing for local, custom domain, & Vercel preview frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://lint-iq.vercel.app",
        "https://thelintiq.com",
        "https://www.thelintiq.com",
    ],
    allow_origin_regex=r"https://lint-.*-hellogunvantsolankis-projects\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize, migrate, and index database on startup
init_db()
ensure_db_indexes()

# Caches for AI challenges and category counts
_pending_ai_problem: Optional[Dict[str, Any]] = None
_ai_problems_cache: Dict[int, Dict[str, Any]] = {}
_categories_cache: Optional[Dict[str, Any]] = None


@app.get("/")
def root():
    return {
        "status": "OK",
        "service": "LintIQ Engine",
        "version": "1.4.0",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/categories")
def get_categories():
    global _categories_cache
    if _categories_cache is None:
        _categories_cache = fetch_categories_summary()
    return _categories_cache


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
            detail="No challenges were found matching the selected category and difficulty filter.",
        )
    return problem


@app.post("/generate-ai-problem")
def create_ai_problem(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
):
    global _pending_ai_problem, _categories_cache
    try:
        problem = generate_ai_bug_challenge(category=category, difficulty=difficulty)
        _pending_ai_problem = problem
        _categories_cache = None  # Invalidate cached counts when a new problem is added
        if problem and "id" in problem:
            _ai_problems_cache[int(problem["id"])] = problem
        return problem
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/submit-patch")
def submit_patch(
    payload: SubmitPatchRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    # Verify token only when a logged-in user submits, so guests can still test patches
    if payload.user_id:
        verify_token(authorization)

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
def get_user_profile(
    user_id: str,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    verify_token(authorization)
    profile = fetch_user_profile(user_id=user_id)
    if not profile:
        return {
            "id": user_id,
            "streak": 0,
            "solves": 0,
            "tier": "free",
        }
    return profile


@app.get("/leaderboard")
def get_leaderboard():
    return fetch_top_leaderboard(limit=10)