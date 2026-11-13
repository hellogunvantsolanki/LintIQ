import os
import json
import sqlite3
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from problems_data import CURATED_PROBLEMS

DB_PATH = Path("problems.db")


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
    except Exception:
        pass


_load_env_file()

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://rqkymtiatlkrndsqmoys.supabase.co").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P")


def get_connection() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def _supabase_headers(access_token: Optional[str] = None, prefer: Optional[str] = None) -> Dict[str, str]:
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    elif SUPABASE_KEY.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if prefer:
        headers["Prefer"] = prefer
    return headers


def init_db() -> None:
    conn = get_connection()
    cursor = conn.cursor()

    # 1. Create local tables
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

    # 2. Automatic schema migration for problems.db
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

    # 3. Clean any mock or test accounts
    cursor.execute("DELETE FROM user_profiles WHERE id LIKE 'mock_%' OR id LIKE 'test_%'")

    # 4. Sync all 13 curated problems
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
                existing[0]
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
                prob["hint"]
            ))

    conn.commit()
    conn.close()


def fetch_categories_summary() -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT category, COUNT(*) as count
        FROM problems
        GROUP BY category
        ORDER BY category ASC
    """)
    categories = [{"name": r[0], "count": r[1]} for r in cursor.fetchall()]

    cursor.execute("SELECT COUNT(*) FROM problems")
    total = cursor.fetchone()[0]
    conn.close()

    return {"total": total, "categories": categories}


def fetch_random_problem(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
    exclude_id: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()

    def query_problem(ignore_exclude: bool = False):
        conditions = []
        params = []

        if category and category.lower() != "all":
            conditions.append("LOWER(category) = LOWER(?)")
            params.append(category)

        if difficulty and difficulty.lower() != "all":
            conditions.append("LOWER(difficulty) = LOWER(?)")
            params.append(difficulty)

        if exclude_id is not None and not ignore_exclude:
            conditions.append("id != ?")
            params.append(exclude_id)

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
        "hint": row[9]
    }


def fetch_problem_test_cases(problem_id: int) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT test_cases FROM problems WHERE id = ?", (problem_id,))
    row = cursor.fetchone()
    conn.close()
    if row and row[0]:
        return json.loads(row[0]) if isinstance(row[0], str) else row[0]
    return []


def fetch_problem_hint(problem_id: int) -> Optional[str]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT hint FROM problems WHERE id = ?", (problem_id,))
    row = cursor.fetchone()
    conn.close()
    return row[0] if (row and row[0]) else None


# --- SUPABASE CLOUD + LOCAL SQLITE USER PROFILE SYNC ---

def fetch_user_profile(user_id: str, access_token: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not user_id or str(user_id).startswith(("mock_", "test_")):
        return None

    # 1. Try Supabase Cloud Postgres first
    try:
        encoded_id = urllib.parse.quote(str(user_id), safe="")
        url = f"{SUPABASE_URL}/rest/v1/user_profiles?id=eq.{encoded_id}&select=id,username,score,streak,solves,tier"
        req = urllib.request.Request(url, headers=_supabase_headers(access_token=access_token), method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
            if isinstance(rows, list) and len(rows) > 0:
                r = rows[0]
                return {
                    "id": r.get("id"),
                    "username": r.get("username", "Engineer"),
                    "score": int(r.get("score") or 0),
                    "streak": int(r.get("streak") or 0),
                    "solves": int(r.get("solves") or 0),
                    "tier": r.get("tier") or "free",
                    "source": "supabase"
                }
    except Exception:
        pass

    # 2. Fallback to Local SQLite
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, score, streak, solves, tier FROM user_profiles WHERE id = ?",
            (user_id,)
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            return {
                "id": row[0],
                "username": row[1],
                "score": int(row[2] or 0),
                "streak": int(row[3] or 0),
                "solves": int(row[4] or 0),
                "tier": row[5] or "free",
                "source": "sqlite"
            }
    except Exception:
        pass

    return None


def _upsert_supabase_profile(profile: Dict[str, Any], access_token: Optional[str] = None) -> bool:
    try:
        url = f"{SUPABASE_URL}/rest/v1/user_profiles?on_conflict=id"
        payload = {
            "id": profile["id"],
            "username": profile["username"],
            "streak": int(profile["streak"]),
            "score": int(profile["score"]),
            "solves": int(profile["solves"]),
            "tier": profile.get("tier", "free"),
            "last_active": datetime.now(timezone.utc).isoformat()
        }
        data = json.dumps(payload).encode("utf-8")
        headers = _supabase_headers(
            access_token=access_token,
            prefer="resolution=merge-duplicates,return=minimal"
        )
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status in (200, 201, 204)
    except Exception:
        return False


def _upsert_sqlite_profile(profile: Dict[str, Any]) -> None:
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
            profile["username"],
            int(profile["streak"]),
            int(profile["score"]),
            int(profile["solves"]),
            profile.get("tier", "free")
        ))
        conn.commit()
        conn.close()
    except Exception as db_err:
        print(f"SQLite profile sync error: {db_err}")


def record_user_solve(
    user_id: str,
    username: Optional[str],
    time_seconds: int = 0,
    access_token: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    if not user_id or str(user_id).startswith(("mock_", "test_")):
        return None

    clean_name = (username or "Engineer").strip()
    existing = fetch_user_profile(user_id, access_token=access_token)

    curr_streak = existing["streak"] if existing else 0
    curr_score = existing["score"] if existing else 0
    curr_solves = existing["solves"] if existing else 0
    curr_tier = existing["tier"] if existing else "free"

    new_streak = curr_streak + 1
    time_bonus = max(0, 60 - max(0, int(time_seconds or 0)))
    points_earned = 100 + (new_streak * 10) + time_bonus
    new_score = curr_score + points_earned
    new_solves = curr_solves + 1

    updated_profile = {
        "id": user_id,
        "username": clean_name,
        "streak": new_streak,
        "score": new_score,
        "solves": new_solves,
        "tier": curr_tier,
        "points_earned": points_earned
    }

    # Save to both permanent Supabase Cloud and local SQLite cache
    _upsert_sqlite_profile(updated_profile)
    cloud_ok = _upsert_supabase_profile(updated_profile, access_token=access_token)
    updated_profile["cloud_synced"] = cloud_ok
    return updated_profile


def reset_user_streak(
    user_id: str,
    username: Optional[str] = None,
    access_token: Optional[str] = None
) -> None:
    if not user_id or str(user_id).startswith(("mock_", "test_")):
        return

    existing = fetch_user_profile(user_id, access_token=access_token)
    if not existing:
        return

    updated_profile = {
        "id": user_id,
        "username": (username or existing["username"] or "Engineer").strip(),
        "streak": 0,
        "score": existing["score"],
        "solves": existing["solves"],
        "tier": existing.get("tier", "free")
    }
    _upsert_sqlite_profile(updated_profile)
    _upsert_supabase_profile(updated_profile, access_token=access_token)


def fetch_top_leaderboard(limit: int = 10) -> List[Dict[str, Any]]:
    # 1. Fetch local SQLite rows first so we can migrate/merge any local progress
    local_rows: List[Dict[str, Any]] = []
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, username, score, streak, solves, tier
            FROM user_profiles
            WHERE id NOT LIKE 'mock_%' AND id NOT LIKE 'test_%'
            ORDER BY score DESC
            LIMIT ?
        """, (limit,))
        local_rows = [
            {
                "id": r[0],
                "username": r[1],
                "score": int(r[2] or 0),
                "streak": int(r[3] or 0),
                "solves": int(r[4] or 0),
                "tier": r[5] or "free"
            }
            for r in cursor.fetchall()
        ]
        conn.close()
    except Exception:
        pass

    # 2. Query Supabase Cloud Postgres
    try:
        query_params = (
            f"select=id,username,score,streak,solves,tier"
            f"&id=not.like.mock_*&id=not.like.test_*"
            f"&order=score.desc&limit={int(limit)}"
        )
        url = f"{SUPABASE_URL}/rest/v1/user_profiles?{query_params}"
        req = urllib.request.Request(url, headers=_supabase_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            cloud_rows = json.loads(resp.read().decode("utf-8"))
            if isinstance(cloud_rows, list):
                cloud_map = {
                    r["id"]: {
                        "id": r["id"],
                        "username": r.get("username", "Engineer"),
                        "score": int(r.get("score") or 0),
                        "streak": int(r.get("streak") or 0),
                        "solves": int(r.get("solves") or 0),
                        "tier": r.get("tier") or "free"
                    }
                    for r in cloud_rows
                    if r.get("id") and not str(r.get("id")).startswith(("mock_", "test_"))
                }

                # Sync any local real users missing or ahead in SQLite up to Supabase Cloud
                for loc in local_rows:
                    cid = loc["id"]
                    if cid not in cloud_map or loc["score"] > cloud_map[cid]["score"]:
                        _upsert_supabase_profile(loc)
                        cloud_map[cid] = loc

                merged = sorted(cloud_map.values(), key=lambda x: x["score"], reverse=True)
                return merged[:limit]
    except Exception:
        pass

    return local_rows