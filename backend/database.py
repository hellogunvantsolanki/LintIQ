import os
import re
import json
import time
import base64
import atexit
import random
import hashlib
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any, Tuple, Set

import httpx
from problems_data import CURATED_PROBLEMS

logger = logging.getLogger(__name__)

DB_PATH = Path("problems.db")
AI_PROBLEM_ID_THRESHOLD = 100000

# Strict allow-lists (eliminates PostgREST filter / wildcard injection — Bug #4)
ALLOWED_CATEGORIES: Dict[str, str] = {
    "algorithms": "Algorithms",
    "data structures": "Data Structures",
    "off-by-one": "Off-by-One",
    "edge cases": "Edge Cases",
    "type coercion": "Type Coercion",
    "memory & state": "Memory & State",
    "concurrency": "Concurrency",
}

ALLOWED_DIFFICULTIES: Dict[str, str] = {
    "easy": "Easy",
    "medium": "Medium",
    "hard": "Hard",
}

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Short-lived thread-safe cache for Supabase Auth JWT verification (stores SHA-256 hashes only)
_TOKEN_CACHE_LOCK = threading.Lock()
_TOKEN_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_TOKEN_CACHE_TTL_SEC = 60.0
_TOKEN_CACHE_MAX_SIZE = 2000


def _load_env_file() -> None:
    env_path = Path(".env")
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception as exc:
        logger.warning("Could not parse .env file: %s", exc)


_load_env_file()

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://rqkymtiatlkrndsqmoys.supabase.co").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P")
SUPABASE_SERVICE_ROLE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    or os.getenv("SUPABASE_SECRET_KEY", "").strip()
)

# Persistent HTTP keep-alive connection pool for Supabase REST & Auth APIs
_SUPABASE_HTTP = httpx.Client(
    base_url=SUPABASE_URL,
    timeout=httpx.Timeout(connect=3.0, read=5.0, write=4.0, pool=5.0),
    limits=httpx.Limits(max_connections=40, max_keepalive_connections=20, keepalive_expiry=30.0),
)
atexit.register(_SUPABASE_HTTP.close)


def has_supabase_service_key() -> bool:
    return bool(SUPABASE_SERVICE_ROLE_KEY)


def is_valid_user_id(user_id: Optional[str]) -> bool:
    """Strictly validates Supabase Auth UUIDs to prevent PostgREST filter tampering."""
    if not user_id or not isinstance(user_id, str):
        return False
    return bool(_UUID_RE.match(user_id.strip()))


def validate_category_filter(category: Optional[str]) -> Optional[str]:
    """Returns canonical category name, None for 'All', or raises ValueError on invalid input."""
    if not category:
        return None
    norm = category.strip().lower()
    if norm in ("", "all", "all tracks"):
        return None
    canonical = ALLOWED_CATEGORIES.get(norm)
    if canonical is None:
        raise ValueError("Invalid category filter.")
    return canonical


def validate_difficulty_filter(difficulty: Optional[str]) -> Optional[str]:
    """Returns canonical difficulty name, None for 'All', or raises ValueError on invalid input."""
    if not difficulty:
        return None
    norm = difficulty.strip().lower()
    if norm in ("", "all", "all levels"):
        return None
    canonical = ALLOWED_DIFFICULTIES.get(norm)
    if canonical is None:
        raise ValueError("Invalid difficulty filter.")
    return canonical


def _sanitize_username(raw_name: Optional[str]) -> str:
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", str(raw_name or "")).strip()
    return (cleaned[:40] or "Engineer")


def _extract_jwt_exp(token: str) -> Optional[float]:
    """Reads JWT exp claim only to fail fast on expired tokens and cap cache TTL."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding).decode("utf-8"))
        exp = payload.get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def verify_supabase_token(access_token: Optional[str]) -> Optional[Dict[str, Any]]:
    """
    Cryptographically verifies a user's Supabase JWT via Supabase Auth (/auth/v1/user)
    with a 60-second bounded in-memory cache. Returns verified user dict or None.
    """
    if not access_token or not isinstance(access_token, str):
        return None
    token = access_token.strip()
    if len(token) < 20 or len(token) > 4096:
        return None

    now = time.time()
    jwt_exp = _extract_jwt_exp(token)
    if jwt_exp is not None and jwt_exp <= now:
        return None

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with _TOKEN_CACHE_LOCK:
        cached = _TOKEN_CACHE.get(token_hash)
        if cached and now < cached[0]:
            return dict(cached[1])

    try:
        resp = _SUPABASE_HTTP.get(
            "/auth/v1/user",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        uid = str(data.get("id") or "").strip()
        if not is_valid_user_id(uid):
            return None

        meta = data.get("user_metadata") or {}
        email = str(data.get("email") or "").strip()
        fallback_name = email.split("@")[0] if "@" in email else "Engineer"
        display_name = _sanitize_username(
            meta.get("full_name") or meta.get("user_name") or fallback_name
        )

        verified_user = {
            "id": uid,
            "username": display_name,
            "email": email,
        }

        cache_until = now + _TOKEN_CACHE_TTL_SEC
        if jwt_exp is not None:
            cache_until = min(cache_until, jwt_exp)

        with _TOKEN_CACHE_LOCK:
            if len(_TOKEN_CACHE) >= _TOKEN_CACHE_MAX_SIZE:
                expired_keys = [k for k, (exp_ts, _) in _TOKEN_CACHE.items() if exp_ts <= now]
                for k in expired_keys:
                    _TOKEN_CACHE.pop(k, None)
                if len(_TOKEN_CACHE) >= _TOKEN_CACHE_MAX_SIZE:
                    _TOKEN_CACHE.clear()
            _TOKEN_CACHE[token_hash] = (cache_until, verified_user)

        return dict(verified_user)
    except Exception as exc:
        logger.warning("Supabase token verification error: %s", exc)
        return None


def get_connection() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, timeout=10.0)


def _supabase_headers(
    access_token: Optional[str] = None,
    prefer: Optional[str] = None,
    use_service_role: bool = False,
) -> Dict[str, str]:
    api_key = SUPABASE_SERVICE_ROLE_KEY if (use_service_role and SUPABASE_SERVICE_ROLE_KEY) else SUPABASE_KEY
    headers = {
        "apikey": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if use_service_role and SUPABASE_SERVICE_ROLE_KEY:
        # New sb_secret_... keys are authenticated via apikey only; legacy eyJ... JWTs also use Bearer.
        if SUPABASE_SERVICE_ROLE_KEY.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"
    elif access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    elif api_key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {api_key}"
    if prefer:
        headers["Prefer"] = prefer
    return headers


def init_db() -> None:
    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS problems (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                difficulty TEXT NOT NULL,
                category TEXT DEFAULT 'Algorithms',
                tags TEXT DEFAULT '[]',
                language TEXT DEFAULT 'python',
                buggy_code TEXT NOT NULL,
                test_cases TEXT NOT NULL,
                hint TEXT NOT NULL
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_profiles (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                streak INTEGER DEFAULT 0,
                score INTEGER DEFAULT 0,
                solves INTEGER DEFAULT 0,
                tier TEXT DEFAULT 'free',
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_solves (
                user_id TEXT NOT NULL,
                problem_id INTEGER NOT NULL,
                best_points INTEGER DEFAULT 0,
                best_grade TEXT DEFAULT 'Refactor',
                solved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, problem_id)
            )
        """)

        cursor.execute("PRAGMA table_info(problems)")
        existing_cols = {row[1] for row in cursor.fetchall()}

        if "hint" not in existing_cols:
            cursor.execute("ALTER TABLE problems ADD COLUMN hint TEXT DEFAULT 'Inspect edge cases and loop bounds.'")
        if "category" not in existing_cols:
            cursor.execute("ALTER TABLE problems ADD COLUMN category TEXT DEFAULT 'Algorithms'")
        if "tags" not in existing_cols:
            cursor.execute("ALTER TABLE problems ADD COLUMN tags TEXT DEFAULT '[]'")
        if "language" not in existing_cols:
            cursor.execute("ALTER TABLE problems ADD COLUMN language TEXT DEFAULT 'python'")

        cursor.execute("DELETE FROM user_profiles WHERE id LIKE 'mock_%' OR id LIKE 'test_%'")

        for prob in CURATED_PROBLEMS:
            cursor.execute("SELECT id FROM problems WHERE title = ?", (prob["title"],))
            existing = cursor.fetchone()
            if existing:
                cursor.execute("""
                    UPDATE problems
                    SET description = ?, difficulty = ?, category = ?, tags = ?, language = ?,
                        buggy_code = ?, test_cases = ?, hint = ?
                    WHERE id = ?
                """, (
                    prob["description"],
                    prob["difficulty"],
                    prob["category"],
                    json.dumps(prob["tags"]),
                    prob["language"],
                    prob["buggy_code"],
                    json.dumps(prob["test_cases"]),
                    prob["hint"],
                    existing[0],
                ))
            else:
                cursor.execute("""
                    INSERT INTO problems (title, description, difficulty, category, tags, language, buggy_code, test_cases, hint)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    prob["title"],
                    prob["description"],
                    prob["difficulty"],
                    prob["category"],
                    json.dumps(prob["tags"]),
                    prob["language"],
                    prob["buggy_code"],
                    json.dumps(prob["test_cases"]),
                    prob["hint"],
                ))

        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Shared Supabase AI Bug Pool (IDs >= 100001)
# ---------------------------------------------------------------------------

def _normalize_supabase_problem(row: Dict[str, Any]) -> Dict[str, Any]:
    raw_tags = row.get("tags")
    if isinstance(raw_tags, str):
        try:
            raw_tags = json.loads(raw_tags)
        except Exception:
            raw_tags = []
    raw_tests = row.get("test_cases")
    if isinstance(raw_tests, str):
        try:
            raw_tests = json.loads(raw_tests)
        except Exception:
            raw_tests = []

    return {
        "id": int(row["id"]),
        "title": row.get("title", "AI Bug Challenge"),
        "description": row.get("description", ""),
        "difficulty": row.get("difficulty", "Medium"),
        "category": row.get("category", "Algorithms"),
        "tags": raw_tags if isinstance(raw_tags, list) else [],
        "language": row.get("language") or "python",
        "buggy_code": row.get("buggy_code", ""),
        "test_cases": raw_tests if isinstance(raw_tests, list) else [],
        "hint": row.get("hint", "Inspect loop boundaries and edge conditions."),
    }


def insert_ai_problem_to_supabase(problem: Dict[str, Any]) -> Optional[int]:
    """Inserts a verified AI bug into Supabase ai_problems (returns permanent ID >= 100001)."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        return None
    try:
        cat = validate_category_filter(problem.get("category")) or "Algorithms"
        diff = validate_difficulty_filter(problem.get("difficulty")) or "Medium"
        payload = {
            "title": problem["title"],
            "description": problem["description"],
            "difficulty": diff,
            "category": cat,
            "tags": problem.get("tags", []),
            "language": problem.get("language", "python"),
            "buggy_code": problem["buggy_code"],
            "test_cases": problem.get("test_cases", []),
            "hint": problem.get("hint", "Inspect edge cases and loop bounds."),
        }
        resp = _SUPABASE_HTTP.post(
            "/rest/v1/ai_problems",
            json=payload,
            headers=_supabase_headers(prefer="return=representation", use_service_role=True),
        )
        if 200 <= resp.status_code < 300:
            rows = resp.json()
            if isinstance(rows, list) and rows and "id" in rows[0]:
                return int(rows[0]["id"])
        else:
            logger.warning("Supabase ai_problems insert HTTP %s", resp.status_code)
    except Exception as exc:
        logger.warning("Supabase ai_problems insert failed: %s", exc)
    return None


_AI_TABLE_MISSING_WARNED = False


def _warn_missing_ai_table_once(status_code: int) -> None:
    global _AI_TABLE_MISSING_WARNED
    if status_code == 404 and not _AI_TABLE_MISSING_WARNED:
        _AI_TABLE_MISSING_WARNED = True
        logger.warning(
            "Supabase 'ai_problems' table returned 404 Not Found; falling back to local SQLite catalog. "
            "Run backend/supabase_rls_hardening.sql in Supabase SQL Editor to create it."
        )


def _fetch_seen_ai_problem_ids(
    user_id: Optional[str],
    access_token: Optional[str] = None,
) -> Set[int]:
    if not is_valid_user_id(user_id):
        return set()
    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_seen_ai_problems",
            params={"user_id": f"eq.{user_id}", "select": "problem_id", "limit": "2000"},
            headers=_supabase_headers(
                access_token=access_token,
                use_service_role=not bool(access_token),
            ),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list):
                return {int(r["problem_id"]) for r in rows if r.get("problem_id") is not None}
    except Exception as exc:
        logger.warning("Could not fetch user_seen_ai_problems: %s", exc)
    return set()


def mark_ai_problem_seen(
    user_id: Optional[str],
    problem_id: int,
    access_token: Optional[str] = None,
) -> None:
    """Marks an AI problem ID as seen for a verified signed-in user in Supabase."""
    if not is_valid_user_id(user_id) or int(problem_id) < AI_PROBLEM_ID_THRESHOLD:
        return
    try:
        _SUPABASE_HTTP.post(
            "/rest/v1/user_seen_ai_problems",
            params={"on_conflict": "user_id,problem_id"},
            json={
                "user_id": user_id,
                "problem_id": int(problem_id),
                "seen_at": datetime.now(timezone.utc).isoformat(),
            },
            headers=_supabase_headers(
                access_token=access_token,
                prefer="resolution=merge-duplicates,return=minimal",
                use_service_role=not bool(access_token),
            ),
        )
    except Exception as exc:
        logger.warning("Could not mark AI problem %s seen: %s", problem_id, exc)


def fetch_unseen_ai_problem(
    user_id: Optional[str] = None,
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
    exclude_ids: Optional[Set[int]] = None,
    access_token: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], int]:
    """
    Fetches 1 unseen AI problem from the shared Supabase pool using strictly
    allow-listed exact equality filters (no ilike wildcards).
    Returns (problem_dict_or_None, remaining_unseen_count).
    """
    safe_cat = validate_category_filter(category)
    safe_diff = validate_difficulty_filter(difficulty)

    seen_ids: Set[int] = set(exclude_ids or set())
    if is_valid_user_id(user_id):
        seen_ids |= _fetch_seen_ai_problem_ids(user_id, access_token=access_token)

    try:
        params: Dict[str, str] = {
            "select": "id,title,description,difficulty,category,tags,language,buggy_code,test_cases,hint",
            "order": "id.desc",
            "limit": "80",
        }
        if safe_cat:
            params["category"] = f"eq.{safe_cat}"
        if safe_diff:
            params["difficulty"] = f"eq.{safe_diff}"

        resp = _SUPABASE_HTTP.get(
            "/rest/v1/ai_problems",
            params=params,
            headers=_supabase_headers(),
        )
        if resp.status_code == 404:
            _warn_missing_ai_table_once(404)
            return None, 0
        if resp.status_code != 200:
            logger.warning("Supabase ai_problems query returned HTTP %s", resp.status_code)
            return None, 0

        rows = resp.json()
        if not isinstance(rows, list) or not rows:
            return None, 0

        unseen = [
            r for r in rows
            if int(r["id"]) not in seen_ids
            and (not safe_cat or str(r.get("category") or "").strip().lower() == safe_cat.lower())
        ]
        if not unseen:
            return None, 0

        chosen = random.choice(unseen[:15])
        problem = _normalize_supabase_problem(chosen)
        return problem, max(0, len(unseen) - 1)
    except Exception as exc:
        logger.warning("Supabase fetch_unseen_ai_problem failed: %s", exc)
        return None, 0


def count_supabase_ai_problems(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
) -> int:
    safe_cat = validate_category_filter(category)
    safe_diff = validate_difficulty_filter(difficulty)
    try:
        params: Dict[str, str] = {"select": "id"}
        if safe_cat:
            params["category"] = f"eq.{safe_cat}"
        if safe_diff:
            params["difficulty"] = f"eq.{safe_diff}"

        resp = _SUPABASE_HTTP.get(
            "/rest/v1/ai_problems",
            params=params,
            headers=_supabase_headers(prefer="count=exact"),
        )
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            total_str = content_range.split("/")[-1].strip()
            if total_str.isdigit():
                return int(total_str)
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list):
                return len(rows)
    except Exception:
        pass
    return 0


def _fetch_supabase_ai_problem_by_id(problem_id: int) -> Optional[Dict[str, Any]]:
    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/ai_problems",
            params={
                "id": f"eq.{int(problem_id)}",
                "select": "id,title,description,difficulty,category,tags,language,buggy_code,test_cases,hint",
                "limit": "1",
            },
            headers=_supabase_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                return _normalize_supabase_problem(rows[0])
    except Exception as exc:
        logger.warning("Supabase fetch AI problem #%s failed: %s", problem_id, exc)
    return None


# ---------------------------------------------------------------------------
# Problem Catalog Queries (Local Curated SQLite + Supabase AI Pool)
# ---------------------------------------------------------------------------

def fetch_categories_summary() -> Dict[str, Any]:
    """
    Returns deduplicated track counts from the static problems.db catalog
    (matching GET /problems COUNT(DISTINCT title) so counts are 100% identical
    across problem-directory.html, index.html, and profile.html).
    """
    counts: Dict[str, int] = {}
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT category, COUNT(DISTINCT title) as count
            FROM problems
            GROUP BY category
        """)
        for cat_name, cnt in cursor.fetchall():
            if cat_name:
                counts[cat_name] = int(cnt)
    finally:
        conn.close()

    categories = [{"name": k, "count": counts[k]} for k in sorted(counts.keys())]
    return {"total": sum(counts.values()), "categories": categories}


def fetch_random_problem(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
    exclude_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    safe_cat = validate_category_filter(category)
    safe_diff = validate_difficulty_filter(difficulty)

    conn = get_connection()
    try:
        cursor = conn.cursor()

        def query_problem(ignore_exclude: bool = False):
            conditions = []
            params: List[Any] = []

            if safe_cat:
                conditions.append("LOWER(category) = LOWER(?)")
                params.append(safe_cat)

            if safe_diff:
                conditions.append("LOWER(difficulty) = LOWER(?)")
                params.append(safe_diff)

            if exclude_id is not None and not ignore_exclude:
                conditions.append("id != ?")
                params.append(int(exclude_id))

            where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
            sql = f"""
                SELECT id, title, description, difficulty, category, tags, language, buggy_code, test_cases, hint
                FROM problems
                {where_clause}
                ORDER BY RANDOM()
                LIMIT 1
            """
            cursor.execute(sql, params)
            return cursor.fetchone()

        row = query_problem(ignore_exclude=False)
        if not row and exclude_id is not None:
            row = query_problem(ignore_exclude=True)
    finally:
        conn.close()

    if not row:
        return None

    tags = json.loads(row[5]) if isinstance(row[5], str) else (row[5] or [])
    test_cases = json.loads(row[8]) if isinstance(row[8], str) else (row[8] or [])

    return {
        "id": row[0],
        "title": row[1],
        "description": row[2],
        "difficulty": row[3],
        "category": row[4],
        "tags": tags,
        "language": row[6] or "python",
        "buggy_code": row[7],
        "test_cases": test_cases,
        "hint": row[9],
    }


def fetch_problem_eval_data(problem_id: int) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Fetches test_cases + buggy_code from Supabase (AI IDs >= 100000) or SQLite (< 100000)."""
    pid = int(problem_id)
    if pid >= AI_PROBLEM_ID_THRESHOLD:
        prob = _fetch_supabase_ai_problem_by_id(pid)
        if prob:
            return prob.get("test_cases", []), prob.get("buggy_code")
        return [], None

    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT test_cases, buggy_code FROM problems WHERE id = ?", (pid,))
        row = cursor.fetchone()
    finally:
        conn.close()
    if not row:
        return [], None
    raw_tests, starter_code = row[0], row[1]
    tests = json.loads(raw_tests) if isinstance(raw_tests, str) else (raw_tests or [])
    return tests, starter_code


def fetch_problem_hint(problem_id: int) -> Optional[str]:
    pid = int(problem_id)
    if pid >= AI_PROBLEM_ID_THRESHOLD:
        prob = _fetch_supabase_ai_problem_by_id(pid)
        return prob.get("hint") if prob else None

    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT hint FROM problems WHERE id = ?", (pid,))
        row = cursor.fetchone()
    finally:
        conn.close()
    return row[0] if (row and row[0]) else None


# ---------------------------------------------------------------------------
# User Profiles, Permanent Supabase user_solves & Leaderboard
# ---------------------------------------------------------------------------

def calculate_solve_points(
    next_streak: int,
    time_seconds: int = 0,
    multiplier: float = 1.0,
) -> int:
    """Computes total points for a passing patch including Surgical Patch multiplier."""
    safe_mult = min(2.0, max(1.0, float(multiplier or 1.0)))
    time_bonus = max(0, 60 - max(0, int(time_seconds or 0)))
    base_points = 100 + (max(1, int(next_streak)) * 10) + time_bonus
    return int(round(base_points * safe_mult))


def fetch_user_profile(user_id: str, access_token: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not is_valid_user_id(user_id):
        return None

    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_profiles",
            params={"id": f"eq.{user_id}", "select": "id,username,score,streak,solves,tier"},
            headers=_supabase_headers(access_token=access_token),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                r = rows[0]
                return {
                    "id": r.get("id"),
                    "username": r.get("username", "Engineer"),
                    "score": int(r.get("score") or 0),
                    "streak": int(r.get("streak") or 0),
                    "solves": int(r.get("solves") or 0),
                    "tier": r.get("tier") or "free",
                    "source": "supabase",
                }
    except Exception as exc:
        logger.warning("Supabase fetch_user_profile failed: %s", exc)

    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, score, streak, solves, tier FROM user_profiles WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        if row:
            return {
                "id": row[0],
                "username": row[1],
                "score": int(row[2] or 0),
                "streak": int(row[3] or 0),
                "solves": int(row[4] or 0),
                "tier": row[5] or "free",
                "source": "sqlite",
            }
    except Exception as exc:
        logger.warning("SQLite fetch_user_profile failed: %s", exc)
    finally:
        if conn:
            conn.close()

    return None


def ensure_user_profile(user_id: str, username: Optional[str] = None) -> Dict[str, Any]:
    """Creates a default user_profiles row server-side (via service role) if one does not exist."""
    clean_name = _sanitize_username(username)
    profile = {
        "id": user_id,
        "username": clean_name,
        "streak": 0,
        "score": 0,
        "solves": 0,
        "tier": "free",
    }
    if is_valid_user_id(user_id):
        _upsert_supabase_profile(profile, access_token=None)
        _upsert_sqlite_profile(profile)
    return profile


def _normalize_iso_utc(raw_ts: Any) -> Optional[str]:
    if not raw_ts:
        return None
    s = str(raw_ts).strip()
    if not s:
        return None
    try:
        # Handle SQLite "YYYY-MM-DD HH:MM:SS" or ISO strings
        cleaned = s.replace(" ", "T")
        if cleaned.endswith("Z"):
            dt = datetime.fromisoformat(cleaned[:-1] + "+00:00")
        elif "+" in cleaned[10:] or "-" in cleaned[10:]:
            dt = datetime.fromisoformat(cleaned)
        else:
            dt = datetime.fromisoformat(cleaned).replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return s


def fetch_user_solve_history(
    user_id: str,
    access_token: Optional[str] = None,
    limit: int = 1000,
) -> List[Dict[str, Any]]:
    """Fetches real solve timestamps & grades from Supabase user_solves (with SQLite fallback)."""
    if not is_valid_user_id(user_id):
        return []

    rows_out: List[Dict[str, Any]] = []
    use_srv = has_supabase_service_key()
    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_solves",
            params={
                "user_id": f"eq.{user_id}",
                "select": "problem_id,best_points,best_grade,solved_at",
                "order": "solved_at.desc",
                "limit": str(min(2000, max(1, int(limit)))),
            },
            headers=_supabase_headers(
                access_token=None if use_srv else access_token,
                use_service_role=use_srv or not bool(access_token),
            ),
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list):
                for r in data:
                    if r.get("problem_id") is None:
                        continue
                    rows_out.append({
                        "problem_id": int(r["problem_id"]),
                        "best_points": int(r.get("best_points") or 0),
                        "best_grade": str(r.get("best_grade") or "Refactor"),
                        "solved_at": _normalize_iso_utc(r.get("solved_at")),
                    })
                return rows_out
    except Exception as exc:
        logger.warning("Supabase fetch_user_solve_history failed: %s", exc)

    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT problem_id, best_points, best_grade, solved_at
            FROM user_solves
            WHERE user_id = ?
            ORDER BY solved_at DESC
            LIMIT ?
            """,
            (user_id, min(2000, max(1, int(limit)))),
        )
        for pid, pts, grade, ts in cursor.fetchall():
            rows_out.append({
                "problem_id": int(pid),
                "best_points": int(pts or 0),
                "best_grade": str(grade or "Refactor"),
                "solved_at": _normalize_iso_utc(ts),
            })
    except Exception as exc:
        logger.warning("SQLite fetch_user_solve_history failed: %s", exc)
    finally:
        if conn:
            conn.close()

    return rows_out


def compute_activity_summary(solve_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Computes solve_dates, 365-day daily_activity, total_active_days, current_streak, and max_streak."""
    solve_dates: List[str] = []
    day_counts: Dict[str, int] = {}

    for r in solve_rows:
        ts = r.get("solved_at")
        if not ts:
            continue
        solve_dates.append(ts)
        day_str = str(ts)[:10]
        if len(day_str) == 10:
            day_counts[day_str] = day_counts.get(day_str, 0) + 1

    today_utc = datetime.now(timezone.utc).date()
    cutoff_utc = today_utc - timedelta(days=364)

    daily_activity = [
        {"date": d_str, "count": cnt}
        for d_str, cnt in sorted(day_counts.items())
        if d_str >= cutoff_utc.isoformat()
    ]

    sorted_days = sorted(datetime.strptime(d, "%Y-%m-%d").date() for d in day_counts.keys())
    total_active_days = len(sorted_days)

    max_streak = 0
    run = 0
    prev_day = None
    for d in sorted_days:
        if prev_day is not None and (d - prev_day).days == 1:
            run += 1
        else:
            run = 1
        if run > max_streak:
            max_streak = run
        prev_day = d

    current_streak = 0
    if sorted_days:
        day_set = set(sorted_days)
        cursor_day = today_utc if today_utc in day_set else (today_utc - timedelta(days=1))
        while cursor_day in day_set:
            current_streak += 1
            cursor_day -= timedelta(days=1)

    return {
        "solve_dates": solve_dates,
        "daily_activity": daily_activity,
        "total_active_days": total_active_days,
        "current_streak": current_streak,
        "max_streak": max_streak,
    }


_IST_TZ = timezone(timedelta(hours=5, minutes=30))


def get_ist_today_yesterday() -> Tuple[str, str]:
    """Returns (today_ist, yesterday_ist) as 'YYYY-MM-DD' strings in IST (UTC+05:30)."""
    now_ist = datetime.now(_IST_TZ)
    today_str = now_ist.strftime("%Y-%m-%d")
    yesterday_str = (now_ist - timedelta(days=1)).strftime("%Y-%m-%d")
    return today_str, yesterday_str


def _to_ist_date_from_ts(raw_ts: Any) -> Optional[str]:
    if not raw_ts:
        return None
    s = str(raw_ts).strip()
    if not s:
        return None
    try:
        cleaned = s.replace(" ", "T")
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_IST_TZ).strftime("%Y-%m-%d")
    except Exception:
        return s[:10] if len(s) >= 10 else None


def get_effective_streak(
    stored_streak: int,
    last_streak_date: Optional[str],
    today_str: Optional[str] = None,
    yesterday_str: Optional[str] = None,
) -> int:
    """Returns active streak if last solve was today or yesterday (IST), else 0."""
    if today_str is None or yesterday_str is None:
        today_str, yesterday_str = get_ist_today_yesterday()
    clean_last = str(last_streak_date or "").strip()
    if clean_last not in (today_str, yesterday_str):
        return 0
    return max(0, int(stored_streak or 0))


def compute_ist_streak_summary(
    solve_rows: List[Dict[str, Any]],
    today_str: Optional[str] = None,
    yesterday_str: Optional[str] = None,
) -> Dict[str, Any]:
    """Computes day-based IST current_streak, max_streak, and last_streak_date from solve history."""
    if today_str is None or yesterday_str is None:
        today_str, yesterday_str = get_ist_today_yesterday()

    ist_days = set()
    for r in solve_rows or []:
        day_ist = _to_ist_date_from_ts(r.get("solved_at"))
        if day_ist and len(day_ist) == 10:
            try:
                ist_days.add(datetime.strptime(day_ist, "%Y-%m-%d").date())
            except ValueError:
                pass

    if not ist_days:
        return {"current_streak": 0, "max_streak": 0, "last_streak_date": None}

    sorted_days = sorted(ist_days)
    last_streak_date = sorted_days[-1].isoformat()

    max_streak = 0
    run = 0
    prev_day = None
    for d in sorted_days:
        if prev_day is not None and (d - prev_day).days == 1:
            run += 1
        else:
            run = 1
        if run > max_streak:
            max_streak = run
        prev_day = d

    today_date = datetime.strptime(today_str, "%Y-%m-%d").date()
    yesterday_date = datetime.strptime(yesterday_str, "%Y-%m-%d").date()

    current_streak = 0
    if today_date in ist_days:
        cursor = today_date
    elif yesterday_date in ist_days:
        cursor = yesterday_date
    else:
        cursor = None

    while cursor is not None and cursor in ist_days:
        current_streak += 1
        cursor -= timedelta(days=1)

    return {
        "current_streak": current_streak,
        "max_streak": max_streak,
        "last_streak_date": last_streak_date,
    }


def compute_next_daily_streak(
    stored_streak: int,
    last_streak_date: Optional[str],
    max_streak: int = 0,
    today_str: Optional[str] = None,
    yesterday_str: Optional[str] = None,
) -> Tuple[int, int, str]:
    """Applies LeetCode-style once-per-day IST streak increment with missed-day reset."""
    if today_str is None or yesterday_str is None:
        today_str, yesterday_str = get_ist_today_yesterday()

    clean_last = str(last_streak_date or "").strip()
    effective_prev = get_effective_streak(
        stored_streak=stored_streak,
        last_streak_date=clean_last,
        today_str=today_str,
        yesterday_str=yesterday_str,
    )

    if clean_last == today_str:
        new_streak = max(1, effective_prev)
    elif clean_last == yesterday_str:
        new_streak = effective_prev + 1
    else:
        new_streak = 1

    new_max = max(int(max_streak or 0), new_streak)
    return new_streak, new_max, today_str


def compute_rank_tier(score: int, raw_tier: Optional[str] = None) -> str:
    clean = str(raw_tier or "").strip()
    if clean and clean.lower() not in ("free", "default", "none"):
        return clean
    if score >= 5000:
        return "Principal Auditor"
    if score >= 2500:
        return "Staff Bug Hunter"
    if score >= 1000:
        return "Bug Hunter III"
    if score >= 300:
        return "Bug Hunter II"
    return "Bug Hunter I"


def _enrich_recent_solves_metadata(solve_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not solve_rows:
        return []
    pids = sorted({int(r["problem_id"]) for r in solve_rows if r.get("problem_id") is not None})
    meta_map: Dict[int, Dict[str, str]] = {}

    if pids:
        conn = None
        try:
            conn = get_connection()
            placeholders = ",".join("?" for _ in pids)
            rows = conn.execute(
                f"SELECT id, title, difficulty, category FROM problems WHERE id IN ({placeholders})",
                pids,
            ).fetchall()
            for r_id, title, diff, cat in rows:
                meta_map[int(r_id)] = {
                    "title": str(title or f"Challenge #{r_id}"),
                    "difficulty": str(diff or "Medium").capitalize(),
                    "category": str(cat or "General"),
                }
        except Exception as exc:
            logger.warning("SQLite metadata enrichment failed: %s", exc)
        finally:
            if conn:
                conn.close()

    enriched: List[Dict[str, Any]] = []
    for r in solve_rows:
        pid = int(r["problem_id"])
        meta = meta_map.get(pid)
        if not meta and pid >= AI_PROBLEM_ID_THRESHOLD:
            ai_prob = _fetch_supabase_ai_problem_by_id(pid)
            if ai_prob:
                meta = {
                    "title": str(ai_prob.get("title") or f"Challenge #{pid}"),
                    "difficulty": str(ai_prob.get("difficulty") or "Medium").capitalize(),
                    "category": str(ai_prob.get("category") or "General"),
                }
        enriched.append({
            "problem_id": pid,
            "title": meta["title"] if meta else f"Challenge #{pid}",
            "difficulty": meta["difficulty"] if meta else "",
            "category": meta["category"] if meta else "",
            "best_points": int(r.get("best_points") or 0),
            "best_grade": str(r.get("best_grade") or "Refactor"),
            "solved_at": r.get("solved_at"),
        })
    return enriched


def fetch_public_profile_by_username(username: str) -> Optional[Dict[str, Any]]:
    """
    Safely looks up a public developer profile by username (PostgREST-injection safe)
    and returns strictly non-PII public stats, heatmap activity, and recent solves.
    """
    clean_name = re.sub(r"[\x00-\x1f\x7f,*()%\"'\\;]", "", str(username or "")).strip()[:64]
    if not clean_name:
        return None

    matched_row: Optional[Dict[str, Any]] = None
    use_srv = has_supabase_service_key()

    try:
        # 1. Exact equality match first (safe eq. filter)
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_profiles",
            params={
                "username": f"eq.{clean_name}",
                "select": "id,username,score,streak,solves,tier",
                "order": "score.desc",
                "limit": "5",
            },
            headers=_supabase_headers(use_service_role=use_srv),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list):
                for r in rows:
                    rid = str(r.get("id") or "")
                    if rid and not rid.startswith(("mock_", "test_")):
                        matched_row = r
                        break

        # 2. Case-insensitive fallback matched in Python (zero wildcard injection risk)
        if not matched_row:
            resp_all = _SUPABASE_HTTP.get(
                "/rest/v1/user_profiles",
                params={
                    "select": "id,username,score,streak,solves,tier",
                    "order": "score.desc",
                    "limit": "500",
                },
                headers=_supabase_headers(use_service_role=use_srv),
            )
            if resp_all.status_code == 200:
                rows = resp_all.json()
                target_lower = clean_name.lower()
                if isinstance(rows, list):
                    for r in rows:
                        rid = str(r.get("id") or "")
                        uname = str(r.get("username") or "").strip()
                        if rid and not rid.startswith(("mock_", "test_")) and uname.lower() == target_lower:
                            matched_row = r
                            break
    except Exception as exc:
        logger.warning("Supabase fetch_public_profile_by_username failed: %s", exc)

    # 3. Local SQLite fallback
    if not matched_row:
        conn = None
        try:
            conn = get_connection()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, username, score, streak, solves, tier
                FROM user_profiles
                WHERE LOWER(TRIM(username)) = LOWER(?)
                  AND id NOT LIKE 'mock_%'
                  AND id NOT LIKE 'test_%'
                ORDER BY score DESC
                LIMIT 1
                """,
                (clean_name,),
            )
            row = cursor.fetchone()
            if row:
                matched_row = {
                    "id": row[0],
                    "username": row[1],
                    "score": row[2],
                    "streak": row[3],
                    "solves": row[4],
                    "tier": row[5],
                }
        except Exception as exc:
            logger.warning("SQLite fetch_public_profile_by_username failed: %s", exc)
        finally:
            if conn:
                conn.close()

    if not matched_row:
        return None

    uid = str(matched_row.get("id") or "")
    score_val = int(matched_row.get("score") or 0)
    solves_val = int(matched_row.get("solves") or 0)
    streak_val = int(matched_row.get("streak") or 0)
    tier_label = compute_rank_tier(score_val, matched_row.get("tier"))

    solve_rows = fetch_user_solve_history(uid, limit=1000) if is_valid_user_id(uid) else []
    activity = compute_activity_summary(solve_rows)
    ist_streak = compute_ist_streak_summary(solve_rows)
    recent_enriched = _enrich_recent_solves_metadata(solve_rows[:20])

    if matched_row.get("last_streak_date") is not None:
        effective_streak = get_effective_streak(streak_val, matched_row.get("last_streak_date"))
    elif solve_rows:
        effective_streak = int(ist_streak["current_streak"] or 0)
    else:
        effective_streak = 0

    unified_max = max(
        int(activity["max_streak"] or 0),
        int(ist_streak["max_streak"] or 0),
        int(matched_row.get("max_streak") or 0),
        effective_streak,
    )

    # Strictly return non-PII public fields (NEVER id, user_id, or email)
    return {
        "username": str(matched_row.get("username") or clean_name),
        "tier": tier_label,
        "score": score_val,
        "solves": max(solves_val, len(solve_rows)),
        "streak": effective_streak,
        "current_streak": effective_streak,
        "max_streak": unified_max,
        "total_active_days": activity["total_active_days"],
        "daily_activity": activity["daily_activity"],
        "solve_dates": activity["solve_dates"],
        "recent_solves": recent_enriched,
    }


def _upsert_supabase_profile(profile: Dict[str, Any], access_token: Optional[str] = None) -> bool:
    try:
        payload = {
            "id": profile["id"],
            "username": _sanitize_username(profile["username"]),
            "streak": int(profile["streak"]),
            "score": int(profile["score"]),
            "solves": int(profile["solves"]),
            "tier": profile.get("tier", "free"),
            "last_active": datetime.now(timezone.utc).isoformat(),
        }
        use_srv = has_supabase_service_key()
        resp = _SUPABASE_HTTP.post(
            "/rest/v1/user_profiles",
            params={"on_conflict": "id"},
            json=payload,
            headers=_supabase_headers(
                access_token=None if use_srv else access_token,
                prefer="resolution=merge-duplicates,return=minimal",
                use_service_role=use_srv or not bool(access_token),
            ),
        )
        return resp.status_code in (200, 201, 204)
    except Exception as exc:
        logger.warning("Supabase profile upsert failed: %s", exc)
        return False


def _upsert_sqlite_profile(profile: Dict[str, Any]) -> None:
    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO user_profiles (id, username, streak, score, solves, tier, last_active)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                username = excluded.username,
                streak = excluded.streak,
                score = excluded.score,
                solves = excluded.solves,
                tier = excluded.tier,
                last_active = CURRENT_TIMESTAMP
        """, (
            profile["id"],
            _sanitize_username(profile["username"]),
            int(profile["streak"]),
            int(profile["score"]),
            int(profile["solves"]),
            profile.get("tier", "free"),
        ))
        conn.commit()
    except Exception as db_err:
        logger.warning("SQLite profile sync error: %s", db_err)
    finally:
        if conn:
            conn.close()


def _get_previous_solve(
    user_id: str,
    problem_id: int,
    access_token: Optional[str] = None,
) -> Optional[Tuple[int, str]]:
    """Checks permanent Supabase Postgres user_solves first, falling back to local SQLite."""
    if not is_valid_user_id(user_id):
        return None

    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_solves",
            params={
                "user_id": f"eq.{user_id}",
                "problem_id": f"eq.{int(problem_id)}",
                "select": "best_points,best_grade",
                "limit": "1",
            },
            headers=_supabase_headers(
                access_token=access_token,
                use_service_role=not bool(access_token),
            ),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                r = rows[0]
                return int(r.get("best_points") or 0), str(r.get("best_grade") or "Refactor")
            if isinstance(rows, list):
                return None
    except Exception as exc:
        logger.warning("Supabase _get_previous_solve failed: %s", exc)

    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT best_points, best_grade FROM user_solves WHERE user_id = ? AND problem_id = ?",
            (user_id, int(problem_id)),
        )
        row = cursor.fetchone()
        if row:
            return int(row[0] or 0), str(row[1] or "Refactor")
    except Exception as exc:
        logger.warning("SQLite _get_previous_solve failed: %s", exc)
    finally:
        if conn:
            conn.close()
    return None


def _save_problem_solve(
    user_id: str,
    problem_id: int,
    best_points: int,
    best_grade: str,
    access_token: Optional[str] = None,
) -> None:
    """Persists solve record to Supabase Postgres (survives Render deploys) + local SQLite cache."""
    if not is_valid_user_id(user_id):
        return

    try:
        _SUPABASE_HTTP.post(
            "/rest/v1/user_solves",
            params={"on_conflict": "user_id,problem_id"},
            json={
                "user_id": user_id,
                "problem_id": int(problem_id),
                "best_points": int(best_points),
                "best_grade": best_grade,
                "solved_at": datetime.now(timezone.utc).isoformat(),
            },
            headers=_supabase_headers(
                access_token=access_token,
                prefer="resolution=merge-duplicates,return=minimal",
                use_service_role=not bool(access_token),
            ),
        )
    except Exception as exc:
        logger.warning("Supabase _save_problem_solve failed: %s", exc)

    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO user_solves (user_id, problem_id, best_points, best_grade, solved_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, problem_id) DO UPDATE SET
                best_points = excluded.best_points,
                best_grade = excluded.best_grade,
                solved_at = CURRENT_TIMESTAMP
        """, (user_id, int(problem_id), int(best_points), best_grade))
        conn.commit()
    except Exception as exc:
        logger.warning("SQLite _save_problem_solve failed: %s", exc)
    finally:
        if conn:
            conn.close()


def record_user_solve(
    user_id: str,
    username: Optional[str],
    time_seconds: int = 0,
    access_token: Optional[str] = None,
    multiplier: float = 1.0,
    problem_id: Optional[int] = None,
    patch_grade: Optional[str] = None,
    daily_multiplier: int = 1,
) -> Optional[Dict[str, Any]]:
    if not is_valid_user_id(user_id):
        return None

    clean_name = _sanitize_username(username)
    existing = fetch_user_profile(user_id, access_token=access_token)

    curr_streak = existing["streak"] if existing else 0
    curr_score = existing["score"] if existing else 0
    curr_solves = existing["solves"] if existing else 0
    curr_tier = existing["tier"] if existing else "free"
    curr_max_streak = int(existing.get("max_streak") or 0) if existing else 0

    # Derive authoritative IST last_streak_date & active streak from solve history unless explicitly provided
    if existing and "last_streak_date" in existing:
        prev_last_date = existing.get("last_streak_date")
        prev_effective_streak = get_effective_streak(curr_streak, prev_last_date)
    else:
        hist_rows = fetch_user_solve_history(user_id, access_token=access_token, limit=500)
        ist_info = compute_ist_streak_summary(hist_rows)
        prev_last_date = ist_info["last_streak_date"]
        prev_effective_streak = ist_info["current_streak"]
        curr_max_streak = max(curr_max_streak, int(ist_info["max_streak"] or 0))

    new_streak, new_max_streak, new_last_streak_date = compute_next_daily_streak(
        stored_streak=prev_effective_streak,
        last_streak_date=prev_last_date,
        max_streak=curr_max_streak,
    )

    grade_label = patch_grade or "Refactor"
    prev_solve = (
        _get_previous_solve(user_id, problem_id, access_token=access_token)
        if problem_id is not None
        else None
    )

    already_solved = prev_solve is not None
    upgraded_grade = False

    safe_daily_mult = 2 if int(daily_multiplier or 1) == 2 else 1

    if prev_solve is not None:
        prev_best_points, _ = prev_solve
        candidate_points = calculate_solve_points(
            next_streak=max(1, new_streak),
            time_seconds=time_seconds,
            multiplier=multiplier,
        ) * safe_daily_mult
        if candidate_points > prev_best_points:
            points_earned = candidate_points - prev_best_points
            upgraded_grade = True
            _save_problem_solve(user_id, problem_id, candidate_points, grade_label, access_token=access_token)
        else:
            points_earned = 0

        new_solves = curr_solves
        new_score = curr_score + points_earned
    else:
        new_solves = curr_solves + 1
        points_earned = calculate_solve_points(
            next_streak=new_streak,
            time_seconds=time_seconds,
            multiplier=multiplier,
        ) * safe_daily_mult
        new_score = curr_score + points_earned
        if problem_id is not None:
            _save_problem_solve(user_id, problem_id, points_earned, grade_label, access_token=access_token)

    updated_profile = {
        "id": user_id,
        "username": clean_name,
        "streak": new_streak,
        "current_streak": new_streak,
        "max_streak": new_max_streak,
        "last_streak_date": new_last_streak_date,
        "score": new_score,
        "solves": new_solves,
        "tier": curr_tier,
        "points_earned": points_earned,
        "already_solved": already_solved,
        "upgraded_grade": upgraded_grade,
    }

    if points_earned > 0 or not already_solved or new_streak != curr_streak:
        _upsert_sqlite_profile(updated_profile)
        cloud_ok = _upsert_supabase_profile(updated_profile, access_token=access_token)
        updated_profile["cloud_synced"] = cloud_ok
    else:
        updated_profile["cloud_synced"] = True

    return updated_profile


def reset_user_streak(
    user_id: str,
    username: Optional[str] = None,
    access_token: Optional[str] = None,
) -> None:
    if not is_valid_user_id(user_id):
        return

    existing = fetch_user_profile(user_id, access_token=access_token)
    if not existing or existing["streak"] == 0:
        return

    updated_profile = {
        "id": user_id,
        "username": _sanitize_username(username or existing["username"]),
        "streak": 0,
        "score": existing["score"],
        "solves": existing["solves"],
        "tier": existing.get("tier", "free"),
    }
    _upsert_sqlite_profile(updated_profile)
    _upsert_supabase_profile(updated_profile, access_token=access_token)


def fetch_top_leaderboard(limit: int = 10) -> List[Dict[str, Any]]:
    safe_limit = min(50, max(1, int(limit)))
    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/user_profiles",
            params={
                "select": "id,username,score,streak,solves,tier",
                "id": "not.like.mock_*",
                "order": "score.desc",
                "limit": str(safe_limit + 5),
            },
            headers=_supabase_headers(),
        )
        if resp.status_code == 200:
            cloud_rows = resp.json()
            if isinstance(cloud_rows, list) and cloud_rows:
                return [
                    {
                        "id": r["id"],
                        "username": r.get("username", "Engineer"),
                        "score": int(r.get("score") or 0),
                        "streak": int(r.get("streak") or 0),
                        "solves": int(r.get("solves") or 0),
                        "tier": r.get("tier") or "free",
                    }
                    for r in cloud_rows
                    if r.get("id") and not str(r.get("id")).startswith(("mock_", "test_"))
                ][:safe_limit]
    except Exception as exc:
        logger.warning("Supabase leaderboard fetch failed, falling back to SQLite: %s", exc)

    conn = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, username, score, streak, solves, tier
            FROM user_profiles
            WHERE id NOT LIKE 'mock_%' AND id NOT LIKE 'test_%'
            ORDER BY score DESC
            LIMIT ?
        """, (safe_limit,))
        return [
            {
                "id": r[0],
                "username": r[1],
                "score": int(r[2] or 0),
                "streak": int(r[3] or 0),
                "solves": int(r[4] or 0),
                "tier": r[5] or "free",
            }
            for r in cursor.fetchall()
        ]
    except Exception as exc:
        logger.warning("SQLite leaderboard fetch failed: %s", exc)
        return []
    finally:
        if conn:
            conn.close()