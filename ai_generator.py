import os
import re
import json
import atexit
import random
import logging
import sqlite3
from typing import Optional, Dict, Any, List

import httpx
from runner import verify_ai_problem_in_sandbox
from database import insert_ai_problem_to_supabase

logger = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "problems.db")

CATEGORIES = [
    "Algorithms",
    "Data Structures",
    "Off-by-One",
    "Edge Cases",
    "Type Coercion",
    "Memory & State",
    "Concurrency",
]

DIFFICULTIES = ["Easy", "Medium", "Hard"]

_RECENT_TITLES: List[str] = []

# Persistent keep-alive HTTP client for Gemini REST calls
_GEMINI_HTTP = httpx.Client(
    timeout=httpx.Timeout(connect=4.0, read=18.0, write=4.0, pool=5.0),
    limits=httpx.Limits(max_connections=10, max_keepalive_connections=5, keepalive_expiry=30.0),
)
atexit.register(_GEMINI_HTTP.close)

_SPOILER_FULL_LINE_RE = re.compile(
    r"^\s*#\s*(?:bug|fix|hint|spoiler|issue|error|broken)\b.*$",
    re.IGNORECASE,
)
_SPOILER_INLINE_RE = re.compile(
    r"\s+#\s*(?:bug|fix|hint|spoiler|issue|error|broken)\b.*$",
    re.IGNORECASE,
)


def _load_env_key() -> str:
    """Reads GEMINI_API_KEY or GOOGLE_API_KEY from environment or local .env file."""
    key_candidates = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "VITE_GEMINI_API_KEY", "API_KEY")
    for key_name in key_candidates:
        val = os.getenv(key_name, "").strip()
        if val:
            return val

    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    clean_val = v.strip().strip('"').strip("'")
                    if k.strip() in key_candidates or clean_val.startswith("AIza"):
                        return clean_val
    return ""


def _clean_tags(tags: List[Any]) -> List[str]:
    cleaned = []
    for t in tags or []:
        s = str(t).strip().lstrip("#").strip()
        if s:
            cleaned.append(s)
    return cleaned[:4] or ["debugging", "logic", "python"]


def _strip_spoiler_comments(code: str) -> str:
    """Removes '# Bug: ...', '# Fix: ...', and '# Hint: ...' spoiler comments safely."""
    if not code:
        return code

    out_lines: List[str] = []
    for line in code.replace("\r\n", "\n").split("\n"):
        if _SPOILER_FULL_LINE_RE.match(line):
            continue
        cleaned = _SPOILER_INLINE_RE.sub("", line).rstrip()
        out_lines.append(cleaned)

    candidate = "\n".join(out_lines).strip() + "\n"
    try:
        compile(candidate, "solution.py", "exec")
        return candidate
    except SyntaxError:
        return code


def _save_to_sqlite_fallback(problem: Dict[str, Any]) -> int:
    """Local dev fallback if SUPABASE_SERVICE_ROLE_KEY is not configured yet."""
    try:
        conn = sqlite3.connect(DB_PATH, timeout=10.0)
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO problems (title, description, difficulty, category, tags, language, buggy_code, test_cases, hint)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            problem["title"],
            problem["description"],
            problem["difficulty"],
            problem["category"],
            json.dumps(problem["tags"]),
            problem.get("language", "python"),
            problem["buggy_code"],
            json.dumps(problem["test_cases"]),
            problem["hint"],
        ))
        row_id = int(cur.lastrowid)
        conn.commit()
        conn.close()
        return row_id
    except Exception as exc:
        logger.warning("SQLite fallback insert failed: %s", exc)
        return random.randint(50000, 99999)


def _call_gemini_api(api_key: str, prompt: str) -> Optional[Dict[str, Any]]:
    """
    Fast Gemini call (~2-4s): disables internal thinking on gemini-2.5-flash
    and falls back to gemini-2.0-flash if needed.
    """
    models = ["gemini-2.5-flash", "gemini-2.0-flash"]

    for model_name in models:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_name}:generateContent?key={api_key}"
        )

        gen_config: Dict[str, Any] = {
            "temperature": 0.85,
            "responseMimeType": "application/json",
        }
        # Disabling thinking cuts gemini-2.5-flash latency from ~25s down to ~2-4s
        if model_name.startswith("gemini-2.5"):
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": gen_config,
        }

        try:
            resp = _GEMINI_HTTP.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code != 200:
                logger.warning("Gemini %s HTTP %s: %s", model_name, resp.status_code, resp.text[:200])
                continue

            raw_data = resp.json()
            parts = raw_data["candidates"][0]["content"]["parts"]
            text_content = "".join(
                part["text"] for part in parts if "text" in part and not part.get("thought")
            ).strip()

            match = re.search(r"\{[\s\S]*\}", text_content)
            if match:
                return json.loads(match.group(0), strict=False)
        except Exception as err:
            logger.warning("Gemini %s error: %s", model_name, err)

    return None


def _generate_procedural_fallback(chosen_cat: str, chosen_diff: str) -> Dict[str, Any]:
    global _RECENT_TITLES

    bank = [
        {
            "category": "Algorithms",
            "title": "Kadane Maximum Subarray Reset",
            "tags": ["dynamic-programming", "subarray", "greedy"],
            "description": "Read space-separated integers (which may all be negative) and print the maximum contiguous subarray sum.",
            "buggy_code": (
                "import sys\n\ndef max_subarray():\n"
                "    nums = list(map(int, sys.stdin.read().split()))\n"
                "    best = 0\n"
                "    curr = 0\n"
                "    for x in nums:\n"
                "        curr = max(x, curr + x)\n"
                "        best = max(best, curr)\n"
                "    print(best)\n\nmax_subarray()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef max_subarray():\n"
                "    nums = list(map(int, sys.stdin.read().split()))\n"
                "    best = nums[0]\n"
                "    curr = nums[0]\n"
                "    for x in nums[1:]:\n"
                "        curr = max(x, curr + x)\n"
                "        best = max(best, curr)\n"
                "    print(best)\n\nmax_subarray()\n"
            ),
            "hint": "Initialize `best = nums[0]` and `curr = nums[0]`, then iterate over `nums[1:]`.",
            "test_cases": [
                {"input": "-5 -2 -9 -4", "expected_output": "-2"},
                {"input": "-2 1 -3 4 -1 2 1 -5 4", "expected_output": "6"},
                {"input": "5 4 -1 7 8", "expected_output": "23"},
                {"input": "-10 -3 -1 -8", "expected_output": "-1"},
            ],
        },
        {
            "category": "Data Structures",
            "title": "Valid Bracket Stack Underflow",
            "tags": ["stack", "strings", "validation"],
            "description": "Read a string of brackets '()', '[]', '{}' and print 'VALID' if properly balanced, or 'INVALID' otherwise.",
            "buggy_code": (
                "import sys\n\ndef is_valid():\n"
                "    s = sys.stdin.read().strip()\n"
                "    stack = []\n"
                "    pairs = {')': '(', ']': '[', '}': '{'}\n"
                "    for ch in s:\n"
                "        if ch in '([{':\n"
                "            stack.append(ch)\n"
                "        elif ch in pairs:\n"
                "            if not stack or stack.pop() != pairs[ch]:\n"
                "                print('INVALID')\n"
                "                return\n"
                "    print('VALID')\n\nis_valid()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef is_valid():\n"
                "    s = sys.stdin.read().strip()\n"
                "    stack = []\n"
                "    pairs = {')': '(', ']': '[', '}': '{'}\n"
                "    for ch in s:\n"
                "        if ch in '([{':\n"
                "            stack.append(ch)\n"
                "        elif ch in pairs:\n"
                "            if not stack or stack.pop() != pairs[ch]:\n"
                "                print('INVALID')\n"
                "                return\n"
                "    print('VALID' if not stack else 'INVALID')\n\nis_valid()\n"
            ),
            "hint": "Verify that `stack` is empty at the end (`not stack`) before printing `'VALID'`.",
            "test_cases": [
                {"input": "(((", "expected_output": "INVALID"},
                {"input": "()[]{}", "expected_output": "VALID"},
                {"input": "([)]", "expected_output": "INVALID"},
                {"input": "{[]}", "expected_output": "VALID"},
            ],
        },
        {
            "category": "Off-by-One",
            "title": "Adjacent Variation Fencepost",
            "tags": ["intervals", "slicing", "loops"],
            "description": "Read N space-separated integers and print the sum of adjacent differences |arr[i+1] - arr[i]| for all valid adjacent pairs.",
            "buggy_code": (
                "import sys\n\ndef total_variation():\n"
                "    arr = list(map(int, sys.stdin.read().split()))\n"
                "    total = 0\n"
                "    for i in range(len(arr)):\n"
                "        total += abs(arr[i + 1] - arr[i])\n"
                "    print(total)\n\ntotal_variation()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef total_variation():\n"
                "    arr = list(map(int, sys.stdin.read().split()))\n"
                "    total = 0\n"
                "    for i in range(len(arr) - 1):\n"
                "        total += abs(arr[i + 1] - arr[i])\n"
                "    print(total)\n\ntotal_variation()\n"
            ),
            "hint": "Stop the loop at `len(arr) - 1` so `arr[i + 1]` stays within list bounds.",
            "test_cases": [
                {"input": "1 5 2 8", "expected_output": "13"},
                {"input": "10 10 10", "expected_output": "0"},
                {"input": "3 -2 7 0", "expected_output": "21"},
                {"input": "42", "expected_output": "0"},
            ],
        },
        {
            "category": "Edge Cases",
            "title": "Second Largest Unique Deduplication",
            "tags": ["sets", "sorting", "boundary"],
            "description": "Read space-separated integers and print the second largest unique integer, or 'NONE' if fewer than 2 unique integers exist.",
            "buggy_code": (
                "import sys\n\ndef second_largest():\n"
                "    nums = list(map(int, sys.stdin.read().split()))\n"
                "    nums.sort(reverse=True)\n"
                "    print(nums[1] if len(nums) >= 2 else 'NONE')\n\nsecond_largest()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef second_largest():\n"
                "    nums = sorted(set(map(int, sys.stdin.read().split())), reverse=True)\n"
                "    print(nums[1] if len(nums) >= 2 else 'NONE')\n\nsecond_largest()\n"
            ),
            "hint": "Convert the integers to a `set()` before sorting so duplicate maximum values don't occupy index 1.",
            "test_cases": [
                {"input": "10 10 10", "expected_output": "NONE"},
                {"input": "5 5 2 8 8", "expected_output": "5"},
                {"input": "42", "expected_output": "NONE"},
                {"input": "1 2 3 4", "expected_output": "3"},
            ],
        },
        {
            "category": "Type Coercion",
            "title": "String Digit Sum Type Mismatch",
            "tags": ["strings", "types", "casting"],
            "description": "Read a positive integer string and print the mathematical sum of its individual digits.",
            "buggy_code": (
                "import sys\n\ndef digit_sum():\n"
                "    s = sys.stdin.read().strip()\n"
                "    total = 0\n"
                "    for ch in s:\n"
                "        total += ch\n"
                "    print(total)\n\ndigit_sum()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef digit_sum():\n"
                "    s = sys.stdin.read().strip()\n"
                "    total = 0\n"
                "    for ch in s:\n"
                "        total += int(ch)\n"
                "    print(total)\n\ndigit_sum()\n"
            ),
            "hint": "Cast each character `ch` to an integer with `int(ch)` before adding it to `total`.",
            "test_cases": [
                {"input": "9875", "expected_output": "29"},
                {"input": "100200", "expected_output": "3"},
                {"input": "42", "expected_output": "6"},
                {"input": "7", "expected_output": "7"},
            ],
        },
        {
            "category": "Memory & State",
            "title": "Mutable Default Accumulator Leak",
            "tags": ["default-args", "references", "functions"],
            "description": "Read space-separated words. For each word, compute a fresh list containing only that word's length and print all lengths space-separated.",
            "buggy_code": (
                "import sys\n\n"
                "def record_len(word, bucket=[]):\n"
                "    bucket.append(len(word))\n"
                "    return sum(bucket)\n\n"
                "words = sys.stdin.read().strip().split()\n"
                "print(' '.join(str(record_len(w)) for w in words))\n"
            ),
            "fixed_code": (
                "import sys\n\n"
                "def record_len(word, bucket=None):\n"
                "    if bucket is None:\n"
                "        bucket = []\n"
                "    bucket.append(len(word))\n"
                "    return sum(bucket)\n\n"
                "words = sys.stdin.read().strip().split()\n"
                "print(' '.join(str(record_len(w)) for w in words))\n"
            ),
            "hint": "Replace `bucket=[]` with `bucket=None` and initialize `bucket = []` inside the function.",
            "test_cases": [
                {"input": "hi code arcade", "expected_output": "2 4 6"},
                {"input": "a bb ccc dddd", "expected_output": "1 2 3 4"},
                {"input": "lint iq", "expected_output": "4 2"},
                {"input": "python", "expected_output": "6"},
            ],
        },
        {
            "category": "Concurrency",
            "title": "Lock Release Deadlock Path",
            "tags": ["locks", "deadlock", "synchronization"],
            "description": "Simulate processing space-separated transaction amounts where negative values are rejected. Print the final balance after all valid transactions.",
            "buggy_code": (
                "import sys\n\ndef process_tx():\n"
                "    amounts = list(map(int, sys.stdin.read().split()))\n"
                "    balance = 0\n"
                "    locked = False\n"
                "    for amt in amounts:\n"
                "        if locked:\n"
                "            break\n"
                "        locked = True\n"
                "        if amt < 0:\n"
                "            continue\n"
                "        balance += amt\n"
                "        locked = False\n"
                "    print(balance)\n\nprocess_tx()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef process_tx():\n"
                "    amounts = list(map(int, sys.stdin.read().split()))\n"
                "    balance = 0\n"
                "    locked = False\n"
                "    for amt in amounts:\n"
                "        if locked:\n"
                "            break\n"
                "        locked = True\n"
                "        if amt >= 0:\n"
                "            balance += amt\n"
                "        locked = False\n"
                "    print(balance)\n\nprocess_tx()\n"
            ),
            "hint": "Ensure `locked = False` is always executed before continuing to the next transaction.",
            "test_cases": [
                {"input": "10 -5 20 30", "expected_output": "60"},
                {"input": "-1 50 50", "expected_output": "100"},
                {"input": "100 200 -10 50", "expected_output": "350"},
                {"input": "5 10 15", "expected_output": "30"},
            ],
        },
    ]

    cat_matches = [
        b for b in bank
        if b["category"].lower() == chosen_cat.lower() and b["title"] not in _RECENT_TITLES
    ]
    if not cat_matches:
        cat_matches = [b for b in bank if b["title"] not in _RECENT_TITLES] or bank

    tpl = random.choice(cat_matches)
    _RECENT_TITLES.append(tpl["title"])
    if len(_RECENT_TITLES) > 5:
        _RECENT_TITLES.pop(0)

    return {
        "title": tpl["title"],
        "difficulty": chosen_diff,
        "category": tpl["category"],
        "tags": _clean_tags(tpl["tags"]),
        "description": tpl["description"],
        "language": "python",
        "buggy_code": tpl["buggy_code"],
        "hint": tpl["hint"],
        "test_cases": tpl["test_cases"],
    }


def generate_ai_bug_challenge(
    category: Optional[str] = None,
    difficulty: Optional[str] = None,
) -> Dict[str, Any]:
    chosen_cat = (
        category
        if category and category.lower() not in ("all", "all tracks")
        else random.choice(CATEGORIES)
    )
    chosen_diff = (
        difficulty.capitalize()
        if difficulty and difficulty.lower() not in ("all", "all levels")
        else random.choice(DIFFICULTIES)
    )

    api_key = _load_env_key()
    verified_problem: Optional[Dict[str, Any]] = None

    if api_key:
        topics = [
            "sliding window", "monotonic stack", "prefix sum", "hash map frequency",
            "two pointers", "binary search", "interval merging", "matrix traversal",
            "anagram grouping", "greedy scheduling", "run-length encoding", "graph BFS",
            "priority queue", "bit manipulation", "string parsing", "rate limiter",
        ]

        for _attempt in range(2):
            seed_topic = random.choice(topics)
            prompt = (
                f"Generate ONE unique Python 3 bug-hunting coding challenge.\n"
                f"- Category: {chosen_cat}\n"
                f"- Difficulty: {chosen_diff}\n"
                f"- Topic: {seed_topic}\n\n"
                "Strict Requirements:\n"
                "1. Both `buggy_code` and `fixed_code` must be standalone Python 3 scripts starting with `import sys` "
                "that read input from `sys.stdin.read().strip()` and `print()` the final result. Use ONLY standard library modules (no os, subprocess, open, eval, exec).\n"
                "2. `buggy_code` must contain a subtle, realistic 1-to-2 line bug that fails at least one test case. "
                "NEVER add any comments explaining, hinting at, or marking the bug (NO `# Bug:` comments!).\n"
                "3. `description` must clearly specify input/output format without spoiling the exact bug.\n"
                "4. `tags` must be a list of 3 short lowercase strings WITHOUT '#' prefixes.\n"
                "5. Return ONLY valid JSON with keys: title, difficulty, category, tags, description, "
                "buggy_code, fixed_code, hint, and test_cases (4 objects with 'input' and 'expected_output')."
            )
            raw = _call_gemini_api(api_key, prompt)
            if not raw or not raw.get("buggy_code") or not raw.get("fixed_code"):
                continue

            buggy_clean = _strip_spoiler_comments(str(raw["buggy_code"]))
            fixed_clean = _strip_spoiler_comments(str(raw["fixed_code"]))
            raw_tcs = raw.get("test_cases") or []
            inputs = [str(tc.get("input", "")) for tc in raw_tcs[:4] if isinstance(tc, dict)]
            if not inputs:
                continue

            # Single batched sandbox call verifies fixed_code outputs AND confirms buggy_code fails
            check = verify_ai_problem_in_sandbox(buggy_clean, fixed_clean, inputs)
            if check.get("valid") and check.get("test_cases"):
                verified_problem = {
                    "title": str(raw.get("title", "AI Bug Challenge")).strip(),
                    "difficulty": chosen_diff,
                    "category": chosen_cat,
                    "tags": _clean_tags(raw.get("tags", [])),
                    "description": str(raw.get("description", "")).strip(),
                    "language": "python",
                    "buggy_code": buggy_clean,
                    "hint": str(raw.get("hint", "Inspect loop bounds and edge cases.")).strip(),
                    "test_cases": check["test_cases"],
                }
                break
            else:
                logger.info("AI verification rejected candidate: %s", check.get("reason"))

    if not verified_problem:
        verified_problem = _generate_procedural_fallback(chosen_cat, chosen_diff)

    # Persist permanently to Supabase shared pool (IDs >= 100001), fallback to SQLite if service key missing
    new_id = insert_ai_problem_to_supabase(verified_problem)
    if new_id is None:
        new_id = _save_to_sqlite_fallback(verified_problem)

    verified_problem["id"] = new_id
    return verified_problem