from collections import OrderedDict, deque
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Deque, Set, Tuple
import json
import logging
import sqlite3
import threading
import time

from fastapi import FastAPI, HTTPException, Query, Header, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from schemas import SubmitPatchRequest, RunCodeRequest, HintRequest
from database import (
    init_db,
    fetch_categories_summary,
    fetch_random_problem,
    fetch_problem_eval_data,
    fetch_problem_hint,
    fetch_user_profile,
    record_user_solve,
    reset_user_streak,
    fetch_top_leaderboard,
    fetch_unseen_ai_problem,
    mark_ai_problem_seen,
    has_supabase_service_key,
    verify_supabase_token,
    validate_category_filter,
    validate_difficulty_filter,
)
from runner import evaluate_patch, run_custom_code
from ai_generator import generate_ai_bug_challenge

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DB_PATH = "problems.db"

# Thread-safe rate limiters (protects OnlineCompiler & Gemini quotas)
_RUN_RATE_LOCK = threading.Lock()
_RUN_RATE_BUCKETS: Dict[str, Deque[float]] = {}
_RUN_MIN_INTERVAL_SEC = 1.2
_RUN_MAX_PER_MIN = 25

_AI_RATE_LOCK = threading.Lock()
_AI_RATE_BUCKETS: Dict[str, Deque[float]] = {}
_AI_MIN_INTERVAL_SEC = 4.0
_AI_MAX_PER_MIN = 12

# Single-flight lock so at most 1 background AI refill runs at a time
_AI_REFILL_LOCK = threading.Lock()
_AI_POOL_MIN_BUFFER = 10

# Thread-safe bounded LRU cache for AI problems (fast server-side lookup for /submit-patch & /get-hint)
_AI_CACHE_LOCK = threading.Lock()
_AI_CACHE_MAX_SIZE = 300
_ai_problems_cache: "OrderedDict[int, Dict[str, Any]]" = OrderedDict()

# Category summary cache with 60s TTL
_categories_cache: Optional[Dict[str, Any]] = None
_categories_cache_ts: float = 0.0
_CATEGORIES_CACHE_TTL = 60.0


def _cache_ai_problem(problem: Optional[Dict[str, Any]]) -> None:
    if not problem or "id" not in problem:
        return
    try:
        pid = int(problem["id"])
    except (TypeError, ValueError):
        return
    with _AI_CACHE_LOCK:
        _ai_problems_cache[pid] = problem
        _ai_problems_cache.move_to_end(pid)
        while len(_ai_problems_cache) > _AI_CACHE_MAX_SIZE:
            _ai_problems_cache.popitem(last=False)


def _get_cached_ai_problem(problem_id: int) -> Optional[Dict[str, Any]]:
    with _AI_CACHE_LOCK:
        prob = _ai_problems_cache.get(problem_id)
        if prob is not None:
            _ai_problems_cache.move_to_end(problem_id)
        return prob


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_bucket_rate_limit(
    lock: threading.Lock,
    buckets: Dict[str, Deque[float]],
    client_ip: str,
    min_interval: float,
    max_per_min: int,
    wait_msg: str,
    cap_msg: str,
) -> None:
    now = time.monotonic()
    with lock:
        if len(buckets) > 5000:
            stale = [ip for ip, dq in buckets.items() if not dq or (now - dq[-1]) > 120]
            for ip in stale:
                buckets.pop(ip, None)

        bucket = buckets.setdefault(client_ip, deque())
        while bucket and (now - bucket[0]) > 60.0:
            bucket.popleft()

        if bucket and (now - bucket[-1]) < min_interval:
            raise HTTPException(status_code=429, detail=wait_msg)

        if len(bucket) >= max_per_min:
            raise HTTPException(status_code=429, detail=cap_msg)

        bucket.append(now)


def _extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip() or None
    return parts[0].strip() or None


def _require_verified_user(authorization: Optional[str]) -> Tuple[Dict[str, Any], str]:
    """Strictly verifies Supabase JWT and returns (verified_user, raw_token) or raises 401."""
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing access token.")
    user = verify_supabase_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired access token.")
    return user, token


def _get_optional_verified_user(authorization: Optional[str]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Verifies optional JWT when present; returns (None, None) for unauthenticated guests."""
    token = _extract_bearer_token(authorization)
    if not token:
        return None, None
    user = verify_supabase_token(token)
    if not user:
        return None, None
    return user, token


def _parse_exclude_ids(raw: Optional[str]) -> Set[int]:
    if not raw:
        return set()
    ids: Set[int] = set()
    for part in raw.split(",")[:100]:
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids


def _validate_filters_or_400(
    category: Optional[str],
    difficulty: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    try:
        return validate_category_filter(category), validate_difficulty_filter(difficulty)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def ensure_db_indexes() -> None:
    """Ensure SQLite indexes exist so 1,500+ problem queries stay sub-millisecond."""
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("CREATE INDEX IF NOT EXISTS idx_problems_cat_diff ON problems(category, difficulty)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_problems_diff ON problems(difficulty)")
        conn.commit()
    except Exception as exc:
        logger.warning("Could not ensure DB indexes: %s", exc)
    finally:
        if conn:
            conn.close()


def _bg_refill_ai_pool(category: Optional[str], difficulty: Optional[str]) -> None:
    """Single-flight background refill: adds 1 verified AI bug into Supabase without blocking users."""
    global _categories_cache
    if not has_supabase_service_key():
        return
    if not _AI_REFILL_LOCK.acquire(blocking=False):
        return
    try:
        new_prob = generate_ai_bug_challenge(category=category, difficulty=difficulty)
        _cache_ai_problem(new_prob)
        _categories_cache = None
    except Exception as exc:
        logger.warning("Background AI pool refill failed: %s", exc)
    finally:
        _AI_REFILL_LOCK.release()


def _bg_mark_seen(user_id: Optional[str], problem_id: int, access_token: Optional[str]) -> None:
    try:
        mark_ai_problem_seen(user_id=user_id, problem_id=problem_id, access_token=access_token)
    except Exception as exc:
        logger.warning("Background mark_ai_problem_seen failed: %s", exc)


def _bg_record_user_solve(
    user_id: str,
    username: Optional[str],
    time_seconds: int,
    access_token: Optional[str],
    multiplier: float = 1.0,
    problem_id: Optional[int] = None,
    patch_grade: Optional[str] = None,
) -> None:
    try:
        record_user_solve(
            user_id=user_id,
            username=username,
            time_seconds=time_seconds,
            access_token=access_token,
            multiplier=multiplier,
            problem_id=problem_id,
            patch_grade=patch_grade,
        )
    except Exception as exc:
        logger.error("Background record_user_solve failed: %s", exc)


def _bg_reset_user_streak(
    user_id: str,
    username: Optional[str],
    access_token: Optional[str],
) -> None:
    try:
        reset_user_streak(
            user_id=user_id,
            username=username,
            access_token=access_token,
        )
    except Exception as exc:
        logger.error("Background reset_user_streak failed: %s", exc)


app = FastAPI(title="LintIQ API", version="1.6.2")

app.add_middleware(GZipMiddleware, minimum_size=500)

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

init_db()
ensure_db_indexes()


@app.get("/")
def root():
    return {
        "status": "OK",
        "service": "LintIQ Engine",
        "version": "1.6.2",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/categories")
def get_categories():
    global _categories_cache, _categories_cache_ts
    now = time.monotonic()
    if _categories_cache is None or (now - _categories_cache_ts) > _CATEGORIES_CACHE_TTL:
        _categories_cache = fetch_categories_summary()
        _categories_cache_ts = now
    return _categories_cache


@app.get("/get-problem")
def get_problem(
    category: Optional[str] = Query(None, description="Filter by problem domain category"),
    difficulty: Optional[str] = Query(None, description="Filter by Easy, Medium, or Hard"),
    exclude_id: Optional[int] = Query(None, description="Exclude current problem ID to avoid immediate repeats"),
):
    safe_cat, safe_diff = _validate_filters_or_400(category, difficulty)
    problem = fetch_random_problem(
        category=safe_cat,
        difficulty=safe_diff,
        exclude_id=exclude_id,
    )
    if not problem:
        raise HTTPException(
            status_code=404,
            detail="No challenges were found matching the selected category and difficulty filter.",
        )
    return problem


@app.get("/problems")
def list_problems_sequential(
    category: str = Query("All"),
    difficulty: str = Query("All"),
    user_id: Optional[str] = Query(None),  # Ignored in favor of verified JWT to prevent IDOR
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    safe_cat, safe_diff = _validate_filters_or_400(category, difficulty)
    verified_user, _ = _get_optional_verified_user(authorization)
    verified_uid = verified_user["id"] if verified_user else None

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()

        where_clauses = []
        params = []

        if safe_cat:
            where_clauses.append("LOWER(category) = LOWER(?)")
            params.append(safe_cat)
        if safe_diff:
            where_clauses.append("LOWER(difficulty) = LOWER(?)")
            params.append(safe_diff)

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        # Deduplicate by title (keeping the lowest ID) so the sequence stays clean
        query = f"""
            SELECT MIN(id) AS id, title, difficulty, category, language
            FROM problems
            {where_sql}
            GROUP BY title
            ORDER BY id ASC
            LIMIT ? OFFSET ?
        """
        rows = cur.execute(query, params + [limit, offset]).fetchall()

        solved_ids: Set[int] = set()
        if verified_uid:
            try:
                solved_rows = cur.execute(
                    "SELECT problem_id FROM user_solves WHERE user_id = ?", (verified_uid,)
                ).fetchall()
                solved_ids = {int(r["problem_id"]) for r in solved_rows}
            except Exception:
                solved_ids = set()

        total_row = cur.execute(
            f"SELECT COUNT(DISTINCT title) AS total FROM problems {where_sql}", params
        ).fetchone()
    finally:
        conn.close()

    return {
        "total": total_row["total"] if total_row else 0,
        "problems": [
            {
                "id": r["id"],
                "title": r["title"],
                "difficulty": r["difficulty"].capitalize() if r["difficulty"] else "",
                "category": r["category"],
                "language": r["language"] or "python",
                "solved": r["id"] in solved_ids,
            }
            for r in rows
        ],
    }


@app.get("/problems/{problem_id}")
def get_problem_by_id(problem_id: int):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM problems WHERE id = ?", (problem_id,)).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Problem not found")

    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "difficulty": row["difficulty"].capitalize() if row["difficulty"] else "",
        "buggy_code": row["buggy_code"],
        "test_cases": json.loads(row["test_cases"]) if isinstance(row["test_cases"], str) else (row["test_cases"] or []),
        "hint": row["hint"],
        "category": row["category"],
        "tags": json.loads(row["tags"] or "[]") if isinstance(row["tags"], str) else (row["tags"] or []),
        "language": row["language"] or "python",
    }


@app.post("/generate-ai-problem")
def create_ai_problem(
    request: Request,
    background_tasks: BackgroundTasks,
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
    user_id: Optional[str] = None,  # Kept for backwards URL compatibility; ignored in favor of verified JWT
    exclude_ids: Optional[str] = None,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    Shared Unseen AI Pool:
    1) Derives user identity strictly from verified Authorization JWT (never trusts query user_id).
    2) Serves an unseen verified AI bug from Supabase in <50ms + refills in background if low.
    """
    global _categories_cache

    _check_bucket_rate_limit(
        lock=_AI_RATE_LOCK,
        buckets=_AI_RATE_BUCKETS,
        client_ip=_get_client_ip(request),
        min_interval=_AI_MIN_INTERVAL_SEC,
        max_per_min=_AI_MAX_PER_MIN,
        wait_msg="Please wait a few seconds before generating another AI bug.",
        cap_msg="AI bug generation rate limit reached. Try again in a minute.",
    )

    safe_cat, safe_diff = _validate_filters_or_400(category, difficulty)
    verified_user, access_token = _get_optional_verified_user(authorization)
    verified_uid = verified_user["id"] if verified_user else None
    parsed_excludes = _parse_exclude_ids(exclude_ids)

    pooled_problem, unseen_remaining = fetch_unseen_ai_problem(
        user_id=verified_uid,
        category=safe_cat,
        difficulty=safe_diff,
        exclude_ids=parsed_excludes,
        access_token=access_token,
    )

    if pooled_problem:
        _cache_ai_problem(pooled_problem)
        if verified_uid:
            background_tasks.add_task(_bg_mark_seen, verified_uid, int(pooled_problem["id"]), access_token)
        if unseen_remaining < _AI_POOL_MIN_BUFFER:
            background_tasks.add_task(_bg_refill_ai_pool, safe_cat, safe_diff)
        return {**pooled_problem, "source": "ai_pool"}

    try:
        problem = generate_ai_bug_challenge(category=safe_cat, difficulty=safe_diff)
        _categories_cache = None
        _cache_ai_problem(problem)
        if verified_uid and "id" in problem:
            background_tasks.add_task(_bg_mark_seen, verified_uid, int(problem["id"]), access_token)
        background_tasks.add_task(_bg_refill_ai_pool, safe_cat, safe_diff)
        return {**problem, "source": "live_ai"}
    except Exception:
        logger.exception("Live AI challenge generation failed")
        raise HTTPException(
            status_code=500,
            detail="Could not generate AI challenge right now. Please try again shortly.",
        )


@app.post("/run-code")
def run_code(payload: RunCodeRequest, request: Request):
    """
    Safe Test Run sandbox: executes user code with custom stdin inside OnlineCompiler.io.
    Never modifies streaks or writes to Supabase.
    """
    _check_bucket_rate_limit(
        lock=_RUN_RATE_LOCK,
        buckets=_RUN_RATE_BUCKETS,
        client_ip=_get_client_ip(request),
        min_interval=_RUN_MIN_INTERVAL_SEC,
        max_per_min=_RUN_MAX_PER_MIN,
        wait_msg="Please wait a moment before running another test.",
        cap_msg="Test Run rate limit reached (25/min). Wait a few seconds and try again.",
    )
    return run_custom_code(
        user_code=payload.user_code,
        stdin_data=payload.stdin or "",
        language=payload.language or "python",
    )


@app.post("/submit-patch")
def submit_patch(
    payload: SubmitPatchRequest,
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    Hardened patch judge (Fixes Bug #3A & #3B):
    - Never trusts client-supplied test_cases; always loads ground-truth tests from server DB/cache.
    - Never trusts client-supplied user_id; derives identity strictly from verified Supabase JWT.
    """
    if not payload.problem_id:
        raise HTTPException(status_code=400, detail="Missing problem_id.")

    verified_user: Optional[Dict[str, Any]] = None
    verified_token: Optional[str] = None

    if authorization or payload.user_id:
        verified_user, verified_token = _require_verified_user(authorization)

    # Always fetch authoritative test cases & starter code from server-side cache/DB
    test_cases = None
    starter_code: Optional[str] = None

    cached_prob = _get_cached_ai_problem(payload.problem_id)
    if cached_prob:
        test_cases = cached_prob.get("test_cases")
        starter_code = cached_prob.get("buggy_code")

    if not test_cases or starter_code is None:
        db_tests, db_starter = fetch_problem_eval_data(payload.problem_id)
        if not test_cases:
            test_cases = db_tests
        if starter_code is None:
            starter_code = db_starter

    if not test_cases:
        raise HTTPException(status_code=404, detail="Problem test cases not found on server.")

    result = evaluate_patch(
        user_code=payload.user_code,
        test_cases=test_cases,
        language=getattr(payload, "language", "python") or "python",
        starter_code=starter_code,
    )

    if verified_user and verified_token:
        verified_uid = verified_user["id"]
        verified_name = verified_user.get("username") or payload.username or "Engineer"

        if result["passed"]:
            patch_metrics = result.get("patch_metrics") or {}
            background_tasks.add_task(
                _bg_record_user_solve,
                user_id=verified_uid,
                username=verified_name,
                time_seconds=payload.time_seconds or 0,
                access_token=verified_token,
                multiplier=float(patch_metrics.get("multiplier", 1.0)),
                problem_id=payload.problem_id,
                patch_grade=patch_metrics.get("grade"),
            )
        else:
            background_tasks.add_task(
                _bg_reset_user_streak,
                user_id=verified_uid,
                username=verified_name,
                access_token=verified_token,
            )

    return result


@app.post("/get-hint")
def get_hint(payload: HintRequest):
    if payload.problem_id:
        cached_prob = _get_cached_ai_problem(payload.problem_id)
        if cached_prob and cached_prob.get("hint"):
            return {"hint": cached_prob["hint"]}

        hint = fetch_problem_hint(payload.problem_id)
        if hint:
            return {"hint": hint}

    return {"hint": "Examine variable boundaries, data types, and how loops handle edge conditions."}


@app.get("/profile/{user_id}")
def get_user_profile(
    user_id: str,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """Enforces strict JWT verification + owner match (Fixes Bug #2 IDOR)."""
    verified_user, token = _require_verified_user(authorization)
    if verified_user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Forbidden: cannot access another user's profile.")

    profile = fetch_user_profile(user_id=verified_user["id"], access_token=token)
    if not profile:
        return {
            "id": verified_user["id"],
            "streak": 0,
            "solves": 0,
            "tier": "free",
        }
    return profile


@app.get("/leaderboard")
def get_leaderboard():
    return fetch_top_leaderboard(limit=10)