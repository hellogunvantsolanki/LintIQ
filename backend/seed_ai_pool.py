"""
LintIQ — Vertex AI Bulk Seeder (backend/seed_ai_pool.py)

Populates Supabase `ai_problems` using Google Cloud Vertex AI (`gemini-2.5-flash`)
authenticated via Application Default Credentials (ADC).

Seeder-only dependencies: see `backend/requirements-seeder.txt`
  pip install -r backend/requirements-seeder.txt
  gcloud auth application-default login

Usage:
  python backend/seed_ai_pool.py --count 50 --category All --difficulty All
  python backend/seed_ai_pool.py --count 10 --category Algorithms --difficulty Medium --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sqlite3
import sys
import time
from typing import Any, Dict, List, Optional, Set

from dotenv import load_dotenv

# Ensure backend/ is on sys.path and load backend/.env BEFORE importing database/runner
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

from ai_generator import CATEGORIES, DIFFICULTIES, _clean_tags, _strip_spoiler_comments
from database import (
    _SUPABASE_HTTP,
    _supabase_headers,
    has_supabase_service_key,
    insert_ai_problem_to_supabase,
    validate_category_filter,
    validate_difficulty_filter,
)
from runner import evaluate_patch

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("seed_ai_pool")

DEFAULT_PROJECT = "project-17a46f00-75ee-43e1-b6e"
DEFAULT_LOCATION = "us-central1"
VERTEX_MODEL = "gemini-2.5-flash"

TOPIC_SEEDS = [
    "sliding window",
    "monotonic stack",
    "prefix sum",
    "hash map frequency",
    "two pointers",
    "binary search",
    "interval merging",
    "matrix traversal",
    "anagram grouping",
    "greedy scheduling",
    "run-length encoding",
    "graph BFS",
    "priority queue",
    "bit manipulation",
    "string parsing",
    "rate limiter",
    "cache eviction",
    "state machine",
    "recursion memoization",
    "boundary clamping",
    "floating point precision",
    "event ordering",
    "retry backoff",
    "circular buffer",
]


def load_existing_titles() -> Set[str]:
    """Loads existing problem titles from local problems.db and Supabase ai_problems."""
    titles: Set[str] = set()

    db_path = os.path.join(BACKEND_DIR, "problems.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path, timeout=10.0)
            for (title,) in conn.execute("SELECT title FROM problems"):
                if title:
                    titles.add(str(title).strip().lower())
            conn.close()
        except Exception as exc:
            logger.warning("Could not read titles from problems.db: %s", exc)

    try:
        resp = _SUPABASE_HTTP.get(
            "/rest/v1/ai_problems",
            params={"select": "title", "limit": "10000"},
            headers=_supabase_headers(),
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list):
                for r in rows:
                    t = r.get("title")
                    if t:
                        titles.add(str(t).strip().lower())
        else:
            logger.warning("Supabase title fetch HTTP %s", resp.status_code)
    except Exception as exc:
        logger.warning("Could not read titles from Supabase ai_problems: %s", exc)

    return titles


def create_vertex_client(project_id: str, location: str):
    """Creates a Vertex AI google-genai client using Application Default Credentials (ADC)."""
    try:
        from google import genai
    except ImportError as exc:
        raise RuntimeError(
            "Missing `google-genai`. Install seeder deps with: "
            "pip install -r backend/requirements-seeder.txt"
        ) from exc

    return genai.Client(vertexai=True, project=project_id, location=location)


def _is_retryable_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    retry_markers = ("429", "500", "502", "503", "504", "resource_exhausted", "unavailable", "rate limit", "timeout")
    return any(m in msg for m in retry_markers)


def generate_candidate_with_backoff(
    client: Any,
    category: str,
    difficulty: str,
    avoid_titles: List[str],
    max_retries: int = 5,
) -> Optional[Dict[str, Any]]:
    """Calls Vertex AI gemini-2.5-flash with exponential backoff on 429/5xx errors."""
    from google.genai import types

    seed_topic = random.choice(TOPIC_SEEDS)
    avoid_sample = ", ".join(avoid_titles[-15:]) if avoid_titles else "None"

    prompt = (
        f"Generate ONE unique Python 3 bug-hunting coding challenge.\n"
        f"- Category: {category}\n"
        f"- Difficulty: {difficulty}\n"
        f"- Topic: {seed_topic}\n"
        f"- Do NOT reuse or closely copy these existing titles: {avoid_sample}\n\n"
        "Strict Requirements:\n"
        "1. Both `buggy_code` and `fixed_code` must be standalone Python 3 scripts starting with `import sys` "
        "that read input from `sys.stdin.read().strip()` and `print()` the final result. "
        "Use ONLY Python standard library modules (no os, subprocess, open, eval, exec, socket, urllib).\n"
        "2. `buggy_code` must contain a subtle, realistic 1-to-2 line bug that fails at least one test case. "
        "NEVER add any comments explaining, hinting at, or marking the bug (NO `# Bug:` comments!).\n"
        "3. `fixed_code` must pass 100% of the test cases.\n"
        "4. `description` must clearly specify input/output format without spoiling the exact bug.\n"
        "5. `tags` must be a list of 3 short lowercase strings WITHOUT '#' prefixes.\n"
        "6. `test_cases` must contain 4 deterministic test objects with keys `'input'` (string) and `'expected_output'` (string).\n"
        "7. Return ONLY valid JSON with keys: title, difficulty, category, tags, description, "
        "buggy_code, fixed_code, hint, test_cases."
    )

    config_kwargs: Dict[str, Any] = {
        "temperature": 0.9,
        "response_mime_type": "application/json",
    }
    if hasattr(types, "ThinkingConfig"):
        config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)

    config = types.GenerateContentConfig(**config_kwargs)

    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=VERTEX_MODEL,
                contents=prompt,
                config=config,
            )
            text = (getattr(response, "text", None) or "").strip()
            if not text:
                logger.warning("Vertex AI returned empty text")
                return None

            match = re.search(r"\{[\s\S]*\}", text)
            if not match:
                logger.warning("Vertex AI response did not contain JSON object")
                return None

            return json.loads(match.group(0), strict=False)
        except Exception as exc:
            if _is_retryable_error(exc) and attempt < max_retries - 1:
                delay = min(60.0, 2.0 * (2 ** attempt)) + random.uniform(0.1, 0.8)
                logger.warning(
                    "Retryable Vertex AI error (%s). Backing off %.1fs (attempt %d/%d)...",
                    exc,
                    delay,
                    attempt + 1,
                    max_retries,
                )
                time.sleep(delay)
                continue
            logger.error("Vertex AI generation error: %s", exc)
            return None

    return None


def verify_candidate(
    raw: Dict[str, Any],
    category: str,
    difficulty: str,
    existing_titles: Set[str],
) -> tuple[Optional[Dict[str, Any]], str]:
    """
    Quality gate:
    1. Schema & non-empty fields
    2. Title deduplication against problems.db + Supabase ai_problems
    3. buggy_code MUST fail at least 1 test case via runner.evaluate_patch
    4. fixed_code MUST pass 100% of test cases via runner.evaluate_patch
    """
    title = str(raw.get("title", "")).strip()
    description = str(raw.get("description", "")).strip()
    buggy_raw = str(raw.get("buggy_code", "")).strip()
    fixed_raw = str(raw.get("fixed_code", "")).strip()
    hint = str(raw.get("hint", "")).strip() or "Inspect loop boundaries, state updates, and edge cases."

    if not title or not description or not buggy_raw or not fixed_raw:
        return None, "missing required fields (title/description/buggy_code/fixed_code)"

    norm_title = title.lower()
    if norm_title in existing_titles:
        return None, f"duplicate title '{title}'"

    buggy_clean = _strip_spoiler_comments(buggy_raw)
    fixed_clean = _strip_spoiler_comments(fixed_raw)
    if buggy_clean.strip() == fixed_clean.strip():
        return None, "buggy_code is identical to fixed_code"

    raw_tcs = raw.get("test_cases")
    if not isinstance(raw_tcs, list) or len(raw_tcs) == 0:
        return None, "no test_cases provided"

    test_cases: List[Dict[str, str]] = []
    for tc in raw_tcs[:6]:
        if isinstance(tc, dict) and "input" in tc and "expected_output" in tc:
            test_cases.append(
                {
                    "input": str(tc["input"]),
                    "expected_output": str(tc["expected_output"]),
                }
            )
    if len(test_cases) < 2:
        return None, "fewer than 2 valid test_cases"

    # Check 1: buggy_code MUST FAIL at least 1 test case
    buggy_res = evaluate_patch(
        user_code=buggy_clean,
        test_cases=test_cases,
        language="python",
        starter_code=buggy_clean,
    )
    if buggy_res.get("passed"):
        return None, "buggy_code unexpectedly passed 100% of test_cases"

    # Check 2: fixed_code MUST PASS 100% of test cases
    fixed_res = evaluate_patch(
        user_code=fixed_clean,
        test_cases=test_cases,
        language="python",
        starter_code=buggy_clean,
    )
    if not fixed_res.get("passed"):
        reason = fixed_res.get("message") or "fixed_code failed verification"
        return None, f"fixed_code failed: {reason}"

    verified = {
        "title": title,
        "description": description,
        "difficulty": difficulty,
        "category": category,
        "tags": _clean_tags(raw.get("tags", [])),
        "language": "python",
        "buggy_code": buggy_clean,
        "test_cases": test_cases,
        "hint": hint,
    }
    return verified, "ok"


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bulk-seed Supabase ai_problems using Google Cloud Vertex AI (gemini-2.5-flash)."
    )
    parser.add_argument(
        "--count",
        type=int,
        default=50,
        help="Target number of verified challenges to generate/insert (default: 50).",
    )
    parser.add_argument(
        "--category",
        type=str,
        default="All",
        help=f"Track filter: 'All' or one of {', '.join(CATEGORIES)} (default: All).",
    )
    parser.add_argument(
        "--difficulty",
        type=str,
        default="All",
        help=f"Difficulty filter: 'All' or one of {', '.join(DIFFICULTIES)} (default: All).",
    )
    parser.add_argument(
        "--location",
        type=str,
        default=DEFAULT_LOCATION,
        help=f"GCP Vertex AI region (default: {DEFAULT_LOCATION}).",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=DEFAULT_PROJECT,
        help=f"GCP Project ID (default: {DEFAULT_PROJECT}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate and verify challenges without inserting into Supabase.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.count < 1:
        logger.error("--count must be >= 1")
        return 1

    cat_filter = None if args.category.strip().lower() == "all" else validate_category_filter(args.category)
    if args.category.strip().lower() != "all" and not cat_filter:
        logger.error("Invalid --category '%s'. Allowed: All, %s", args.category, ", ".join(CATEGORIES))
        return 1

    diff_filter = None if args.difficulty.strip().lower() == "all" else validate_difficulty_filter(args.difficulty)
    if args.difficulty.strip().lower() != "all" and not diff_filter:
        logger.error("Invalid --difficulty '%s'. Allowed: All, %s", args.difficulty, ", ".join(DIFFICULTIES))
        return 1

    if not args.dry_run and not has_supabase_service_key():
        logger.error(
            "SUPABASE_SERVICE_ROLE_KEY is missing in backend/.env. "
            "Configure it or pass --dry-run to test without inserting."
        )
        return 1

    client = create_vertex_client(project_id=args.project, location=args.location)
    existing_titles = load_existing_titles()
    logger.info(
        "Loaded %d existing titles for deduplication. Starting Vertex AI seeder "
        "(project=%s, location=%s, target=%d, dry_run=%s).",
        len(existing_titles),
        args.project,
        args.location,
        args.count,
        args.dry_run,
    )

    stats = {"generated": 0, "verified": 0, "inserted": 0, "rejected": 0}
    max_attempts = max(args.count * 3, args.count + 10)
    recent_titles = list(existing_titles)[-20:]

    for attempt_idx in range(1, max_attempts + 1):
        if stats["verified"] >= args.count:
            break

        chosen_cat = cat_filter or CATEGORIES[(attempt_idx - 1) % len(CATEGORIES)]
        chosen_diff = diff_filter or DIFFICULTIES[(attempt_idx - 1) % len(DIFFICULTIES)]

        raw = generate_candidate_with_backoff(
            client=client,
            category=chosen_cat,
            difficulty=chosen_diff,
            avoid_titles=recent_titles,
        )
        stats["generated"] += 1

        if not raw:
            stats["rejected"] += 1
            logger.info(
                "[#%d] Rejected: Vertex AI returned no valid JSON | Generated=%d Verified=%d Inserted=%d Rejected=%d",
                attempt_idx,
                stats["generated"],
                stats["verified"],
                stats["inserted"],
                stats["rejected"],
            )
            continue

        verified, reason = verify_candidate(
            raw=raw,
            category=chosen_cat,
            difficulty=chosen_diff,
            existing_titles=existing_titles,
        )
        if not verified:
            stats["rejected"] += 1
            logger.info(
                "[#%d] Rejected (%s) | Generated=%d Verified=%d Inserted=%d Rejected=%d",
                attempt_idx,
                reason,
                stats["generated"],
                stats["verified"],
                stats["inserted"],
                stats["rejected"],
            )
            continue

        stats["verified"] += 1
        existing_titles.add(verified["title"].lower())
        recent_titles.append(verified["title"])

        if args.dry_run:
            logger.info(
                "[#%d] Verified (DRY RUN): '%s' [%s/%s] | Generated=%d Verified=%d Inserted=%d Rejected=%d",
                attempt_idx,
                verified["title"],
                chosen_cat,
                chosen_diff,
                stats["generated"],
                stats["verified"],
                stats["inserted"],
                stats["rejected"],
            )
        else:
            new_id = insert_ai_problem_to_supabase(verified)
            if new_id is not None:
                stats["inserted"] += 1
                logger.info(
                    "[#%d] Inserted ID=%d '%s' [%s/%s] | Generated=%d Verified=%d Inserted=%d Rejected=%d",
                    attempt_idx,
                    new_id,
                    verified["title"],
                    chosen_cat,
                    chosen_diff,
                    stats["generated"],
                    stats["verified"],
                    stats["inserted"],
                    stats["rejected"],
                )
            else:
                stats["rejected"] += 1
                logger.warning(
                    "[#%d] Supabase insert failed for '%s' | Generated=%d Verified=%d Inserted=%d Rejected=%d",
                    attempt_idx,
                    verified["title"],
                    stats["generated"],
                    stats["verified"],
                    stats["inserted"],
                    stats["rejected"],
                )

    print(
        f"\n=== Seeder Complete ===\n"
        f"Generated: {stats['generated']}\n"
        f"Verified:  {stats['verified']}\n"
        f"Inserted:  {stats['inserted']}\n"
        f"Rejected:  {stats['rejected']}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
