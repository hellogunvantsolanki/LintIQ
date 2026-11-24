from collections import OrderedDict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, Deque, Set, Tuple
import hashlib
import html
import json
import logging
import os
import sqlite3
import threading
import time

from fastapi import FastAPI, HTTPException, Query, Header, BackgroundTasks, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from schemas import SubmitPatchRequest, RunCodeRequest, HintRequest, ReviewPatchRequest
from database import (
    init_db,
    fetch_categories_summary,
    fetch_random_problem,
    fetch_problem_eval_data,
    fetch_problem_hint,
    fetch_user_profile,
    ensure_user_profile,
    fetch_user_solve_history,
    compute_activity_summary,
    compute_ist_streak_summary,
    get_effective_streak,
    fetch_public_profile_by_username,
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
from ai_generator import generate_ai_bug_challenge, review_user_patch

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

# Strict daily quota for live Gemini AI synthesis (protects LLM quota)
_AI_LIVE_LOCK = threading.Lock()
_AI_LIVE_DAILY_BUCKETS: Dict[str, Deque[float]] = {}
_AI_LIVE_GLOBAL_BUCKET: Deque[float] = deque()
_AI_LIVE_WINDOW_SEC = 86400.0
_AI_LIVE_GUEST_DAILY_LIMIT = 8
_AI_LIVE_USER_DAILY_LIMIT = 25
_AI_LIVE_GLOBAL_DAILY_LIMIT = 200

_HINT_RATE_LOCK = threading.Lock()
_HINT_RATE_BUCKETS: Dict[str, Deque[float]] = {}
_HINT_MIN_INTERVAL_SEC = 1.5
_HINT_MAX_PER_MIN = 20

_REVIEW_RATE_LOCK = threading.Lock()
_REVIEW_RATE_BUCKETS: Dict[str, Deque[float]] = {}
_REVIEW_MIN_INTERVAL_SEC = 2.0
_REVIEW_MAX_PER_MIN = 15

_SUBMIT_RATE_LOCK = threading.Lock()
_SUBMIT_RATE_BUCKETS: Dict[str, Deque[float]] = {}
_SUBMIT_MIN_INTERVAL_SEC = 2.0
_SUBMIT_MAX_PER_MIN = 15

# Bounded server-side solve-start tracker (prevents client-forged time_seconds speed bonuses)
_SOLVE_START_LOCK = threading.Lock()
_SOLVE_START_MAX_SIZE = 5000
_solve_start_times: "OrderedDict[Tuple[str, int], float]" = OrderedDict()
_DEFAULT_NO_BONUS_SECONDS = 60

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


def _record_solve_start(actor_key: str, problem_id: Any) -> None:
    try:
        pid = int(problem_id)
    except (TypeError, ValueError):
        return
    key = (actor_key, pid)
    now = time.monotonic()
    with _SOLVE_START_LOCK:
        _solve_start_times[key] = now
        _solve_start_times.move_to_end(key)
        while len(_solve_start_times) > _SOLVE_START_MAX_SIZE:
            _solve_start_times.popitem(last=False)


def _consume_solve_elapsed_seconds(
    primary_key: str,
    problem_id: int,
    fallback_key: Optional[str] = None,
) -> int:
    """Computes authoritative elapsed seconds from server start timestamp; clamps <2s or missing to 0 bonus (60s)."""
    now = time.monotonic()
    started_at: Optional[float] = None
    with _SOLVE_START_LOCK:
        for key in ((primary_key, problem_id), (fallback_key, problem_id) if fallback_key else None):
            if key and key in _solve_start_times:
                started_at = _solve_start_times.pop(key)
                break
    if started_at is None:
        return _DEFAULT_NO_BONUS_SECONDS
    elapsed = now - started_at
    if elapsed < 2.0:
        return _DEFAULT_NO_BONUS_SECONDS
    return int(round(elapsed))


def _sanitize_problem_for_client(problem: Dict[str, Any]) -> Dict[str, Any]:
    """Strips hidden grading test cases, keeping only Sample #1 and total test_count."""
    all_tests = problem.get("test_cases") or []
    if not isinstance(all_tests, list):
        all_tests = []
    sanitized = dict(problem)
    sanitized["test_count"] = len(all_tests)
    sanitized["test_cases"] = all_tests[:1]
    return sanitized


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
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


def _check_live_ai_quota(client_ip: str, verified_uid: Optional[str]) -> None:
    """Enforces per-actor and global 24-hour quotas before invoking live LLM synthesis."""
    now = time.monotonic()
    actor_key = f"u:{verified_uid}" if verified_uid else f"ip:{client_ip}"
    actor_limit = _AI_LIVE_USER_DAILY_LIMIT if verified_uid else _AI_LIVE_GUEST_DAILY_LIMIT

    with _AI_LIVE_LOCK:
        if len(_AI_LIVE_DAILY_BUCKETS) > 5000:
            stale = [
                k for k, dq in _AI_LIVE_DAILY_BUCKETS.items()
                if not dq or (now - dq[-1]) > _AI_LIVE_WINDOW_SEC
            ]
            for k in stale:
                _AI_LIVE_DAILY_BUCKETS.pop(k, None)

        while _AI_LIVE_GLOBAL_BUCKET and (now - _AI_LIVE_GLOBAL_BUCKET[0]) > _AI_LIVE_WINDOW_SEC:
            _AI_LIVE_GLOBAL_BUCKET.popleft()
        if len(_AI_LIVE_GLOBAL_BUCKET) >= _AI_LIVE_GLOBAL_DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail="Daily live AI generation capacity reached. Try again later or browse the catalog.",
            )

        bucket = _AI_LIVE_DAILY_BUCKETS.setdefault(actor_key, deque())
        while bucket and (now - bucket[0]) > _AI_LIVE_WINDOW_SEC:
            bucket.popleft()

        if len(bucket) >= actor_limit:
            detail = (
                f"Daily AI generation quota reached ({actor_limit}/day)."
                if verified_uid
                else f"Guest daily AI generation limit reached ({actor_limit}/day). Sign in for higher limits."
            )
            raise HTTPException(status_code=429, detail=detail)

        bucket.append(now)
        _AI_LIVE_GLOBAL_BUCKET.append(now)


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


_IST_TZ = timezone(timedelta(hours=5, minutes=30))


def _get_daily_window_ist() -> Tuple[str, str, str]:
    ist_now = datetime.now(_IST_TZ)
    date_ist = ist_now.strftime("%Y-%m-%d")
    next_ist_midnight = (ist_now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    resets_at_utc = next_ist_midnight.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    resets_at_ist = next_ist_midnight.isoformat()
    return date_ist, resets_at_utc, resets_at_ist


def _get_daily_problem(conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
    """Deterministically picks today's Hard (or fallback all-catalog) daily bug via SHA-256 of IST date."""
    ist_date_str, _, _ = _get_daily_window_ist()
    rows = conn.execute(
        "SELECT id FROM problems WHERE LOWER(COALESCE(difficulty, '')) = 'hard' ORDER BY id ASC"
    ).fetchall()
    if not rows:
        rows = conn.execute("SELECT id FROM problems ORDER BY id ASC").fetchall()
    if not rows:
        return None

    candidate_ids = [int(r[0]) for r in rows]
    idx = int(hashlib.sha256(ist_date_str.encode("utf-8")).hexdigest(), 16) % len(candidate_ids)
    daily_id = candidate_ids[idx]

    row = conn.execute(
        "SELECT id, title, difficulty, category, tags FROM problems WHERE id = ?",
        (daily_id,),
    ).fetchone()
    if not row:
        return None

    raw_tags = row[4]
    if isinstance(raw_tags, str):
        try:
            parsed_tags = json.loads(raw_tags) or []
        except Exception:
            parsed_tags = []
    else:
        parsed_tags = raw_tags or []

    return {
        "id": int(row[0]),
        "title": str(row[1] or f"Challenge #{daily_id}"),
        "difficulty": str(row[2] or "Hard").capitalize(),
        "category": str(row[3] or "General"),
        "tags": parsed_tags[:4] if isinstance(parsed_tags, list) else [],
    }


def _to_ist_date_str(raw_ts: str) -> Optional[str]:
    cleaned = str(raw_ts or "").strip()
    if not cleaned:
        return None
    try:
        iso_str = cleaned.replace(" ", "T")
        if iso_str.endswith("Z"):
            iso_str = iso_str[:-1] + "+00:00"
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_IST_TZ).strftime("%Y-%m-%d")
    except Exception:
        return cleaned[:10] if len(cleaned) >= 10 else None


def _has_solved_daily_today(
    user_id: Optional[str],
    daily_id: Optional[int],
    ist_date_str: str,
    access_token: Optional[str] = None,
) -> bool:
    if not user_id or daily_id is None:
        return False
    try:
        solve_history = fetch_user_solve_history(user_id, access_token=access_token, limit=500)
        for item in solve_history:
            if int(item.get("problem_id") or 0) == int(daily_id):
                solved_at = str(item.get("solved_at") or "").strip()
                if not solved_at:
                    return True
                if _to_ist_date_str(solved_at) == ist_date_str:
                    return True
    except Exception:
        return False
    return False


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

IS_PRODUCTION = os.getenv("ENVIRONMENT", "development").strip().lower() == "production"
ALLOWED_ORIGINS = (
    ["https://thelintiq.com", "https://www.thelintiq.com", "https://lint-iq.vercel.app"]
    if IS_PRODUCTION
    else [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://lint-iq.vercel.app",
        "https://thelintiq.com",
        "https://www.thelintiq.com",
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=None if IS_PRODUCTION else r"https://lint-.*-hellogunvantsolankis-projects\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()
ensure_db_indexes()


@app.get("/")
@app.get("/health")
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


@app.get("/daily-challenge")
def get_daily_challenge(authorization: Optional[str] = Header(None, alias="Authorization")):
    """Returns today's deterministic Bug of the Day, IST midnight reset timestamps, and completion status."""
    date_ist, resets_at_utc, resets_at_ist = _get_daily_window_ist()
    conn = sqlite3.connect(DB_PATH)
    try:
        daily_problem = _get_daily_problem(conn)
    finally:
        conn.close()

    verified_user, access_token = _get_optional_verified_user(authorization)
    completed_today = (
        _has_solved_daily_today(
            user_id=verified_user["id"],
            daily_id=daily_problem["id"],
            ist_date_str=date_ist,
            access_token=access_token,
        )
        if (verified_user and daily_problem)
        else False
    )

    return {
        "date_ist": date_ist,
        "date_utc": date_ist,  # Backwards-compatible alias carrying the authoritative IST rollover date
        "timezone": "IST (UTC+05:30)",
        "resets_at": resets_at_ist,
        "resets_at_utc": resets_at_utc,
        "xp_multiplier": 2,
        "problem": daily_problem,
        "completed_today": completed_today,
    }


@app.get("/get-problem")
def get_problem(
    request: Request,
    category: Optional[str] = Query(None, description="Filter by problem domain category"),
    difficulty: Optional[str] = Query(None, description="Filter by Easy, Medium, or Hard"),
    exclude_id: Optional[int] = Query(None, description="Exclude current problem ID to avoid immediate repeats"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
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
    verified_user, _ = _get_optional_verified_user(authorization)
    actor_key = f"u:{verified_user['id']}" if verified_user else f"ip:{_get_client_ip(request)}"
    _record_solve_start(actor_key, problem["id"])
    return _sanitize_problem_for_client(problem)


@app.get("/problems")
def list_problems_sequential(
    category: str = Query("All"),
    difficulty: str = Query("All"),
    user_id: Optional[str] = Query(None),  # Ignored in favor of verified JWT to prevent IDOR
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    safe_cat, safe_diff = _validate_filters_or_400(category, difficulty)
    verified_user, access_token = _get_optional_verified_user(authorization)
    verified_uid = verified_user["id"] if verified_user else None

    solved_ids: Set[int] = set()
    if verified_uid:
        try:
            solve_history = fetch_user_solve_history(
                verified_uid,
                access_token=access_token,
                limit=2000,
            )
            solved_ids = {int(r["problem_id"]) for r in solve_history if r.get("problem_id") is not None}
        except Exception:
            solved_ids = set()

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

        # Deduplicate by title (keeping the lowest ID) so the directory & sequence stay clean
        query = f"""
            SELECT MIN(id) AS id, title, difficulty, category, language, tags, test_cases, description
            FROM problems
            {where_sql}
            GROUP BY title
            ORDER BY id ASC
            LIMIT ? OFFSET ?
        """
        rows = cur.execute(query, params + [limit, offset]).fetchall()

        if verified_uid:
            try:
                local_solved_rows = cur.execute(
                    "SELECT problem_id FROM user_solves WHERE user_id = ?", (verified_uid,)
                ).fetchall()
                solved_ids |= {int(r["problem_id"]) for r in local_solved_rows}
            except Exception:
                pass

        total_row = cur.execute(
            f"SELECT COUNT(DISTINCT title) AS total FROM problems {where_sql}", params
        ).fetchone()
    finally:
        conn.close()

    problems_out = []
    for r in rows:
        raw_tags = r["tags"]
        if isinstance(raw_tags, str):
            try:
                parsed_tags = json.loads(raw_tags) or []
            except Exception:
                parsed_tags = []
        else:
            parsed_tags = raw_tags or []

        raw_tc = r["test_cases"]
        if isinstance(raw_tc, str):
            try:
                tc_count = len(json.loads(raw_tc) or [])
            except Exception:
                tc_count = 0
        elif isinstance(raw_tc, list):
            tc_count = len(raw_tc)
        else:
            tc_count = 0

        desc_preview = (r["description"] or "").strip().replace("\n", " ")[:150]

        problems_out.append(
            {
                "id": r["id"],
                "title": r["title"],
                "difficulty": r["difficulty"].capitalize() if r["difficulty"] else "Medium",
                "category": r["category"] or "General",
                "language": r["language"] or "python",
                "tags": parsed_tags[:4] if isinstance(parsed_tags, list) else [],
                "test_count": tc_count,
                "description_preview": desc_preview,
                "solved": r["id"] in solved_ids,
            }
        )

    return {
        "total": total_row["total"] if total_row else 0,
        "problems": problems_out,
    }


@app.get("/problems/{problem_id}")
def get_problem_by_id(
    problem_id: int,
    request: Request,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM problems WHERE id = ?", (problem_id,)).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Problem not found")

    verified_user, _ = _get_optional_verified_user(authorization)
    actor_key = f"u:{verified_user['id']}" if verified_user else f"ip:{_get_client_ip(request)}"
    _record_solve_start(actor_key, row["id"])

    return _sanitize_problem_for_client({
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
    })


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

    client_ip = _get_client_ip(request)
    _check_bucket_rate_limit(
        lock=_AI_RATE_LOCK,
        buckets=_AI_RATE_BUCKETS,
        client_ip=client_ip,
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

    actor_key = f"u:{verified_uid}" if verified_uid else f"ip:{client_ip}"

    if pooled_problem:
        if safe_cat:
            pooled_problem["category"] = safe_cat
        _cache_ai_problem(pooled_problem)
        _record_solve_start(actor_key, pooled_problem["id"])
        if verified_uid:
            background_tasks.add_task(_bg_mark_seen, verified_uid, int(pooled_problem["id"]), access_token)
        if unseen_remaining < _AI_POOL_MIN_BUFFER:
            background_tasks.add_task(_bg_refill_ai_pool, safe_cat, safe_diff or "Medium")
        return {**_sanitize_problem_for_client(pooled_problem), "source": "ai_pool"}

    _check_live_ai_quota(client_ip=client_ip, verified_uid=verified_uid)

    try:
        target_diff = safe_diff or "Medium"
        problem = generate_ai_bug_challenge(category=safe_cat, difficulty=target_diff)
        if safe_cat:
            problem["category"] = safe_cat
        _categories_cache = None
        _cache_ai_problem(problem)
        if "id" in problem:
            _record_solve_start(actor_key, problem["id"])
        if verified_uid and "id" in problem:
            background_tasks.add_task(_bg_mark_seen, verified_uid, int(problem["id"]), access_token)
        background_tasks.add_task(_bg_refill_ai_pool, safe_cat, target_diff)
        return {**_sanitize_problem_for_client(problem), "source": "live_ai"}
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
    try:
        return run_custom_code(
            user_code=payload.user_code,
            stdin_data=payload.stdin or "",
            language=payload.language or "python",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/submit-patch")
def submit_patch(
    payload: SubmitPatchRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    Hardened patch judge (Fixes Bug #3A & #3B):
    - Rate-limited per IP (2.0s min interval, 15/min cap).
    - Never trusts client-supplied test_cases; always loads ground-truth tests from server DB/cache.
    - Never trusts client-supplied user_id or time_seconds; derives identity from JWT and elapsed time from server.
    """
    client_ip = _get_client_ip(request)
    _check_bucket_rate_limit(
        lock=_SUBMIT_RATE_LOCK,
        buckets=_SUBMIT_RATE_BUCKETS,
        client_ip=client_ip,
        min_interval=_SUBMIT_MIN_INTERVAL_SEC,
        max_per_min=_SUBMIT_MAX_PER_MIN,
        wait_msg="Please wait a couple seconds before submitting another patch.",
        cap_msg="Submission rate limit reached (15/min). Wait a moment and try again.",
    )

    if not payload.problem_id:
        raise HTTPException(status_code=400, detail="Missing problem_id.")

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

    try:
        result = evaluate_patch(
            user_code=payload.user_code,
            test_cases=test_cases,
            language=getattr(payload, "language", "python") or "python",
            starter_code=starter_code,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    verified_uid = verified_user["id"]
    verified_name = verified_user.get("username") or payload.username or "Engineer"

    if result["passed"]:
        authoritative_elapsed = _consume_solve_elapsed_seconds(
            primary_key=f"u:{verified_uid}",
            problem_id=payload.problem_id,
            fallback_key=f"ip:{client_ip}",
        )
        patch_metrics = result.get("patch_metrics") or {}

        ist_date_str, _, _ = _get_daily_window_ist()
        daily_prob: Optional[Dict[str, Any]] = None
        daily_conn = None
        try:
            daily_conn = sqlite3.connect(DB_PATH)
            daily_prob = _get_daily_problem(daily_conn)
        except Exception:
            daily_prob = None
        finally:
            if daily_conn:
                daily_conn.close()

        is_daily_target = bool(daily_prob and int(payload.problem_id) == int(daily_prob["id"]))
        already_claimed_daily = (
            _has_solved_daily_today(
                user_id=verified_uid,
                daily_id=payload.problem_id,
                ist_date_str=ist_date_str,
                access_token=verified_token,
            )
            if is_daily_target
            else False
        )
        apply_daily_bonus = is_daily_target and not already_claimed_daily

        try:
            updated_profile = record_user_solve(
                user_id=verified_uid,
                username=verified_name,
                time_seconds=authoritative_elapsed,
                access_token=verified_token,
                multiplier=float(patch_metrics.get("multiplier", 1.0)),
                problem_id=payload.problem_id,
                patch_grade=patch_metrics.get("grade"),
                daily_multiplier=2 if apply_daily_bonus else 1,
            )
            if updated_profile:
                result["profile"] = updated_profile
                awarded_now = int(updated_profile.get("points_earned") or 0) > 0
                if apply_daily_bonus and awarded_now:
                    result["daily_bonus"] = True
                    result["xp_multiplier"] = 2
                else:
                    result["daily_bonus"] = False
                    result["xp_multiplier"] = 1
        except Exception as exc:
            logger.error("record_user_solve failed: %s", exc)

    return result


@app.post("/get-hint")
def get_hint(payload: HintRequest, request: Request):
    _check_bucket_rate_limit(
        lock=_HINT_RATE_LOCK,
        buckets=_HINT_RATE_BUCKETS,
        client_ip=_get_client_ip(request),
        min_interval=_HINT_MIN_INTERVAL_SEC,
        max_per_min=_HINT_MAX_PER_MIN,
        wait_msg="Please wait a moment before requesting another hint.",
        cap_msg="Hint rate limit reached (20/min). Try again in a minute.",
    )
    if payload.problem_id:
        cached_prob = _get_cached_ai_problem(payload.problem_id)
        if cached_prob and cached_prob.get("hint"):
            return {"hint": cached_prob["hint"]}

        hint = fetch_problem_hint(payload.problem_id)
        if hint:
            return {"hint": hint}

    return {"hint": "Examine variable boundaries, data types, and how loops handle edge conditions."}


@app.post("/review-patch")
def review_patch(payload: ReviewPatchRequest, request: Request):
    """Rate-limited Senior Engineer code review comparing buggy_code against the user's passing patch."""
    _check_bucket_rate_limit(
        lock=_REVIEW_RATE_LOCK,
        buckets=_REVIEW_RATE_BUCKETS,
        client_ip=_get_client_ip(request),
        min_interval=_REVIEW_MIN_INTERVAL_SEC,
        max_per_min=_REVIEW_MAX_PER_MIN,
        wait_msg="Please wait a moment before requesting another code review.",
        cap_msg="Review rate limit reached (15/min). Try again in a minute.",
    )

    problem_meta: Optional[Dict[str, Any]] = None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT title, difficulty, category, description, buggy_code FROM problems WHERE id = ?",
            (payload.problem_id,),
        ).fetchone()
        if row:
            problem_meta = {
                "title": row["title"],
                "difficulty": row["difficulty"] or "Medium",
                "category": row["category"] or "General",
                "description": row["description"] or "",
                "buggy_code": row["buggy_code"] or "",
            }
    finally:
        conn.close()

    if not problem_meta:
        cached_prob = _get_cached_ai_problem(payload.problem_id)
        if cached_prob:
            problem_meta = {
                "title": cached_prob.get("title") or f"Challenge #{payload.problem_id}",
                "difficulty": cached_prob.get("difficulty") or "Medium",
                "category": cached_prob.get("category") or "General",
                "description": cached_prob.get("description") or "",
                "buggy_code": cached_prob.get("buggy_code") or "",
            }

    if not problem_meta:
        raise HTTPException(status_code=404, detail="Problem not found.")

    return review_user_patch(
        title=problem_meta["title"],
        difficulty=problem_meta["difficulty"],
        category=problem_meta["category"],
        description=problem_meta["description"],
        buggy_code=problem_meta["buggy_code"],
        user_code=payload.user_code,
        language=payload.language or "python",
    )


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
        profile = ensure_user_profile(
            user_id=verified_user["id"],
            username=verified_user.get("username"),
        )

    solve_rows = fetch_user_solve_history(user_id=verified_user["id"], access_token=token)
    activity = compute_activity_summary(solve_rows)
    ist_streak = compute_ist_streak_summary(solve_rows)

    if profile.get("last_streak_date") is not None:
        effective_streak = get_effective_streak(
            int(profile.get("streak") or 0),
            profile.get("last_streak_date"),
        )
    elif solve_rows:
        effective_streak = int(ist_streak["current_streak"] or 0)
    else:
        effective_streak = 0

    unified_max_streak = max(
        int(activity["max_streak"] or 0),
        int(ist_streak["max_streak"] or 0),
        int(profile.get("max_streak") or 0),
        effective_streak,
    )

    return {
        **profile,
        **activity,
        "streak": effective_streak,
        "current_streak": effective_streak,
        "max_streak": unified_max_streak,
        "last_streak_date": profile.get("last_streak_date") or ist_streak["last_streak_date"],
        "recent_solves": solve_rows[:20],
    }


@app.get("/leaderboard")
def get_leaderboard():
    return fetch_top_leaderboard(limit=10)


@app.get("/public-profile/{username}")
def get_public_profile(username: str):
    """Unauthenticated, read-only public profile endpoint (zero PII leaked)."""
    profile = fetch_public_profile_by_username(username)
    if not profile:
        raise HTTPException(status_code=404, detail="Developer profile not found")

    # Defense-in-depth: strip any private keys before serializing
    for forbidden in ("id", "user_id", "email"):
        profile.pop(forbidden, None)
    return profile


def _badge_tier_palette(solves_cnt: int, found: bool = True) -> Dict[str, str]:
    if not found:
        return {
            "c1": "#64748b",
            "c2": "#334155",
            "c3": "#1e293b",
            "accent": "#94a3b8",
            "sparkle": "#64748b",
            "metal_name": "Unranked",
        }
    if solves_cnt >= 50:
        return {
            "c1": "#6ee7b7",
            "c2": "#10b981",
            "c3": "#047857",
            "accent": "#34d399",
            "sparkle": "#a7f3d0",
            "metal_name": "Emerald Diamond",
        }
    if solves_cnt >= 25:
        return {
            "c1": "#fef08a",
            "c2": "#eab308",
            "c3": "#a16207",
            "accent": "#facc15",
            "sparkle": "#fef9c3",
            "metal_name": "Gold",
        }
    if solves_cnt >= 10:
        return {
            "c1": "#e2e8f0",
            "c2": "#94a3b8",
            "c3": "#475569",
            "accent": "#e2e8f0",
            "sparkle": "#f8fafc",
            "metal_name": "Silver",
        }
    return {
        "c1": "#cd7f32",
        "c2": "#f4b183",
        "c3": "#8c4a1c",
        "accent": "#f4b183",
        "sparkle": "#fed7aa",
        "metal_name": "Bronze",
    }


@app.get("/badge/{username}.svg")
def get_readme_badge_svg(
    username: str,
    style: Optional[str] = Query(None, description="Optional 'pill' for legacy horizontal badge"),
):
    """Embeddable dynamic GitHub README SVG medal (or ?style=pill) with strict XML escaping and 30m caching."""
    profile = fetch_public_profile_by_username(username)
    safe_user = html.escape(str(username or "Engineer"), quote=True)

    if (style or "").strip().lower() == "pill":
        left_text = "LintIQ"
        if not profile:
            right_text = "Profile Not Found"
            right_bg = "#1e293b"
            right_fg = "#94a3b8"
            accent_stroke = "#334155"
        else:
            safe_tier = html.escape(str(profile.get("tier") or "Bug Hunter I"), quote=True)
            solves_cnt = int(profile.get("solves") or 0)
            streak_cnt = int(profile.get("streak") or 0)
            right_text = f"★ {safe_tier} • {solves_cnt} Bugs • {streak_cnt}d Streak"
            right_bg = "#0e4429"
            right_fg = "#e2e8f0"
            accent_stroke = "#10b981"

        left_width = 76
        right_width = max(130, int(len(html.unescape(right_text)) * 6.9) + 26)
        total_width = left_width + right_width
        right_center_x = left_width + (right_width / 2.0)

        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="28" role="img" aria-label="LintIQ badge for {safe_user}">
  <title>LintIQ: {safe_user}</title>
  <defs>
    <clipPath id="r">
      <rect width="{total_width}" height="28" rx="6" fill="#fff"/>
    </clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="{left_width}" height="28" fill="#0d1117"/>
    <rect x="{left_width}" width="{right_width}" height="28" fill="{right_bg}"/>
  </g>
  <rect x="0.5" y="0.5" width="{total_width - 1}" height="27" rx="5.5" fill="none" stroke="{accent_stroke}" stroke-opacity="0.65"/>
  <circle cx="14" cy="14" r="4" fill="#10b981"/>
  <g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" font-weight="600" text-rendering="geometricPrecision">
    <text x="24" y="18" fill="#10b981">{left_text}</text>
    <text x="{right_center_x:.1f}" y="18" fill="{right_fg}" text-anchor="middle">{right_text}</text>
  </g>
</svg>"""
        return Response(
            content=svg,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=1800"},
        )

    # Default: Collectible Circular Achievement Medal SVG (180x210)
    if not profile:
        pal = _badge_tier_palette(0, found=False)
        tier_line = "PROFILE NOT FOUND"
        stats_line = "LINTIQ  •  UNRANKED"
    else:
        solves_cnt = int(profile.get("solves") or 0)
        streak_cnt = int(profile.get("streak") or 0)
        raw_tier = str(profile.get("tier") or "Bug Hunter I").strip().upper()
        tier_line = html.escape(raw_tier, quote=True)
        stats_line = f"{solves_cnt} BUGS  •  {streak_cnt}D STREAK"
        pal = _badge_tier_palette(solves_cnt, found=True)

    tier_font_size = "10.5" if len(html.unescape(tier_line)) <= 16 else "9.2"

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="180" height="210" viewBox="0 0 180 210" role="img" aria-label="LintIQ {pal['metal_name']} Achievement Medal for {safe_user}">
  <title>LintIQ Medal — {safe_user} ({tier_line})</title>
  <defs>
    <linearGradient id="rim-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{pal['c1']}"/>
      <stop offset="50%" stop-color="{pal['c2']}"/>
      <stop offset="100%" stop-color="{pal['c3']}"/>
    </linearGradient>
    <linearGradient id="rim-bevel" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="50%" stop-color="#000000" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.25"/>
    </linearGradient>
    <radialGradient id="crest-grad" cx="42%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </radialGradient>
    <linearGradient id="ribbon-bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#141b26"/>
      <stop offset="100%" stop-color="#090d14"/>
    </linearGradient>
    <filter id="medal-shadow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
  </defs>

  <!-- Outer Metallic Medal Ring -->
  <circle cx="90" cy="86" r="68" fill="url(#rim-grad)" filter="url(#medal-shadow)"/>
  <circle cx="90" cy="86" r="64" fill="none" stroke="url(#rim-bevel)" stroke-width="1.5"/>

  <!-- Inner Dark Crest -->
  <circle cx="90" cy="86" r="57" fill="url(#crest-grad)" stroke="#05080f" stroke-width="1.5"/>
  <circle cx="90" cy="86" r="52" fill="none" stroke="url(#rim-grad)" stroke-width="0.75" stroke-opacity="0.35" stroke-dasharray="3 3"/>

  <!-- Glossy Top-Left Glass Specular Highlight -->
  <path d="M 40 70 A 53 53 0 0 1 130 50 A 66 66 0 0 0 43 86 Z" fill="#ffffff" opacity="0.18"/>

  <!-- Top Micro-Label -->
  <text x="90" y="48" fill="{pal['accent']}" font-family="'JetBrains Mono',Consolas,monospace" font-size="8.5" font-weight="700" letter-spacing="2.8" text-anchor="middle" opacity="0.9">LINTIQ</text>

  <!-- Center Vector Bug-Shield / Terminal Crest -->
  <g transform="translate(90, 88)">
    <!-- Shield Body -->
    <path d="M 0 -24 L 22 -15 L 22 4 C 22 18 11 26 0 30 C -11 26 -22 18 -22 4 L -22 -15 Z"
          fill="#0d1422" stroke="url(#rim-grad)" stroke-width="2.4" stroke-linejoin="round"/>
    <!-- Inner Shield Highlight -->
    <path d="M 0 -19 L 17 -12 L 17 3 C 17 14 8 20 0 24 C -8 20 -17 14 -17 3 L -17 -12 Z"
          fill="url(#rim-grad)" fill-opacity="0.12"/>
    <!-- Terminal Prompt & Patch Check inside Shield -->
    <path d="M -9 -3 L -2 3 L -9 9" fill="none" stroke="url(#rim-grad)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="1" y1="9" x2="10" y2="9" stroke="{pal['accent']}" stroke-width="2.4" stroke-linecap="round"/>
    <!-- Subtle Bug Antennae Crown -->
    <path d="M -6 -25 L -10 -30 M 6 -25 L 10 -30" stroke="url(#rim-grad)" stroke-width="1.8" stroke-linecap="round"/>
  </g>

  <!-- Sparkling Star Accents -->
  <path d="M 49 69 L 51 73 L 55 75 L 51 77 L 49 81 L 47 77 L 43 75 L 47 73 Z" fill="{pal['sparkle']}" opacity="0.9"/>
  <path d="M 131 62 L 132.5 65.5 L 136 67 L 132.5 68.5 L 131 72 L 129.5 68.5 L 126 67 L 129.5 65.5 Z" fill="{pal['sparkle']}" opacity="0.85"/>
  <circle cx="52" cy="108" r="1.5" fill="{pal['sparkle']}" opacity="0.65"/>
  <circle cx="129" cy="106" r="1.5" fill="{pal['sparkle']}" opacity="0.65"/>

  <!-- Bottom Overlapping Ribbon Banner -->
  <g filter="url(#medal-shadow)">
    <rect x="12" y="139" width="156" height="54" rx="10" fill="url(#ribbon-bg)" stroke="url(#rim-grad)" stroke-width="1.8"/>
    <line x1="22" y1="143" x2="158" y2="143" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1"/>
  </g>

  <text x="90" y="161" fill="{pal['accent']}" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="{tier_font_size}" font-weight="700" letter-spacing="0.8" text-anchor="middle" text-rendering="geometricPrecision">{tier_line}</text>
  <text x="90" y="180" fill="#cbd5e1" font-family="'JetBrains Mono',Consolas,monospace" font-size="9.5" font-weight="600" letter-spacing="0.4" text-anchor="middle" text-rendering="geometricPrecision">{stats_line}</text>
</svg>"""

    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=1800"},
    )