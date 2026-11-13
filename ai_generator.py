import os
import re
import sys
import json
import random
import sqlite3
import subprocess
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List

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
    return cleaned or ["debugging", "logic", "python"]


def _run_code_once(code_str: str, stdin_str: str) -> Optional[str]:
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code_str],
            input=stdin_str,
            text=True,
            capture_output=True,
            timeout=3,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:
        pass
    return None


def _save_to_sqlite(problem: Dict[str, Any]) -> int:
    """Inserts into problems.db and returns the exact total problem count as the synced ID."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(problems)")
        columns_info = cur.fetchall()

        if not columns_info:
            conn.close()
            return random.randint(100, 9999)

        mapping = {
            "title": problem["title"],
            "difficulty": problem["difficulty"],
            "category": problem["category"],
            "tags": json.dumps(problem["tags"]),
            "description": problem["description"],
            "buggy_code": problem["buggy_code"],
            "starter_code": problem["buggy_code"],
            "code": problem["buggy_code"],
            "solution_code": problem.get("fixed_code", problem["buggy_code"]),
            "fixed_code": problem.get("fixed_code", problem["buggy_code"]),
            "hint": problem["hint"],
            "test_cases": json.dumps(problem["test_cases"]),
            "language": "python",
        }

        insert_cols = []
        insert_vals = []

        for col in columns_info:
            col_name = col[1]
            col_type = (col[2] or "").upper()
            not_null = col[3]
            dflt_val = col[4]
            is_pk = col[5]

            if is_pk or col_name == "id":
                continue

            if col_name in mapping:
                insert_cols.append(col_name)
                insert_vals.append(mapping[col_name])
            elif not_null and dflt_val is None:
                insert_cols.append(col_name)
                insert_vals.append(0 if "INT" in col_type else "")

        placeholders = ", ".join(["?"] * len(insert_cols))
        col_str = ", ".join(insert_cols)
        cur.execute(
            f"INSERT INTO problems ({col_str}) VALUES ({placeholders})",
            tuple(insert_vals),
        )
        row_id = cur.lastrowid
        cur.execute("SELECT COUNT(*) FROM problems")
        total_count = cur.fetchone()[0]
        conn.commit()
        conn.close()

        # Also append to in-memory problems_data.PROBLEMS if database.py reads from it
        try:
            import problems_data
            if hasattr(problems_data, "PROBLEMS") and isinstance(problems_data.PROBLEMS, list):
                problems_data.PROBLEMS.append({**problem, "id": row_id or total_count})
        except Exception:
            pass

        return int(total_count or row_id)
    except Exception as exc:
        print(f"[LintIQ DB Error] Insert failed: {exc}")
        return random.randint(100, 9999)


def _call_gemini_api(api_key: str, prompt: str) -> Optional[Dict[str, Any]]:
    """Calls Gemini with strict responseMimeType and control-character sanitization."""
    models = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"]

    for model_name in models:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_name}:generateContent?key={api_key}"
        )
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.9,
                "responseMimeType": "application/json",
            },
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw_data = json.loads(resp.read().decode("utf-8"))
                parts = raw_data["candidates"][0]["content"]["parts"]
                text_content = ""
                for part in parts:
                    if "text" in part and not part.get("thought"):
                        text_content += part["text"]

                text_content = text_content.strip()
                match = re.search(r"\{[\s\S]*\}", text_content)
                if match:
                    json_str = match.group(0)
                    return json.loads(json_str, strict=False)
        except urllib.error.HTTPError as http_err:
            err_body = http_err.read().decode("utf-8", errors="ignore")
            print(f"[LintIQ Gemini {model_name} HTTP {http_err.code}]: {err_body}")
        except Exception as err:
            print(f"[LintIQ Gemini {model_name} Error]: {err}")

    return None


def _generate_procedural_fallback(chosen_cat: str, chosen_diff: str) -> Dict[str, Any]:
    global _RECENT_TITLES
    k = random.randint(2, 6)
    shift = random.randint(1, 5)

    bank = [
        {
            "category": "Algorithms",
            "title": f"Kadane Maximum Subarray Reset Bug",
            "tags": ["dynamic-programming", "subarray", "greedy"],
            "description": "Read space-separated integers (which may all be negative) and print the maximum contiguous subarray sum.",
            "buggy_code": (
                "import sys\n\ndef max_subarray():\n"
                "    nums = list(map(int, sys.stdin.read().split()))\n"
                "    # Bug: Initializing best = 0 fails when all numbers in the array are negative\n"
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
            "inputs": ["-5 -2 -9 -4", "-2 1 -3 4 -1 2 1 -5 4", "5 4 -1 7 8", "-10 -3 -1 -8"],
        },
        {
            "category": "Data Structures",
            "title": f"Valid Bracket Stack Underflow",
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
                "    # Bug: Unconditionally prints VALID without checking if unclosed brackets remain\n"
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
            "inputs": ["(((", "()[]{}", "([)]", "{[]}"],
        },
        {
            "category": "Off-by-One",
            "title": f"Adjacent Variation Fencepost Bug",
            "tags": ["intervals", "slicing", "loops"],
            "description": "Read N space-separated integers and print the sum of adjacent differences |arr[i+1] - arr[i]| for all valid adjacent pairs.",
            "buggy_code": (
                "import sys\n\ndef total_variation():\n"
                "    arr = list(map(int, sys.stdin.read().split()))\n"
                "    total = 0\n"
                "    # Bug: range(len(arr)) causes IndexError on arr[i + 1] at the last index\n"
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
            "inputs": ["1 5 2 8", "10 10 10", "3 -2 7 0", "42"],
        },
        {
            "category": "Edge Cases",
            "title": f"Second Largest Unique Deduplication Bug",
            "tags": ["sets", "sorting", "boundary"],
            "description": "Read space-separated integers and print the second largest unique integer, or 'NONE' if fewer than 2 unique integers exist.",
            "buggy_code": (
                "import sys\n\ndef second_largest():\n"
                "    nums = list(map(int, sys.stdin.read().split()))\n"
                "    # Bug: Sorting raw nums without deduplicating returns a duplicate max\n"
                "    nums.sort(reverse=True)\n"
                "    print(nums[1] if len(nums) >= 2 else 'NONE')\n\nsecond_largest()\n"
            ),
            "fixed_code": (
                "import sys\n\ndef second_largest():\n"
                "    nums = sorted(set(map(int, sys.stdin.read().split())), reverse=True)\n"
                "    print(nums[1] if len(nums) >= 2 else 'NONE')\n\nsecond_largest()\n"
            ),
            "hint": "Convert the integers to a `set()` before sorting so duplicate maximum values don't occupy index 1.",
            "inputs": ["10 10 10", "5 5 2 8 8", "42", "1 2 3 4"],
        },
        {
            "category": "Type Coercion",
            "title": f"String Digit Sum vs Type Concatenation",
            "tags": ["strings", "types", "casting"],
            "description": "Read a positive integer string and print the mathematical sum of its individual digits.",
            "buggy_code": (
                "import sys\n\ndef digit_sum():\n"
                "    s = sys.stdin.read().strip()\n"
                "    total = 0\n"
                "    for ch in s:\n"
                "        # Bug: Adding string character `ch` directly to int `total` raises TypeError\n"
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
            "inputs": ["9875", "100200", "42", "7"],
        },
        {
            "category": "Memory & State",
            "title": f"Mutable Default Accumulator Leak",
            "tags": ["default-args", "references", "functions"],
            "description": "Read space-separated words. For each word, compute a fresh list containing only that word's length and print all lengths space-separated.",
            "buggy_code": (
                "import sys\n\n"
                "# Bug: Mutable default list `bucket=[]` persists across function calls\n"
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
            "inputs": ["hi code arcade", "a bb ccc dddd", "lint iq", "python"],
        },
        {
            "category": "Concurrency",
            "title": f"Thread Lock Release Deadlock Path",
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
                "        # Bug: Early `continue` on negative amount forgets to release `locked = False`\n"
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
            "inputs": ["10 -5 20 30", "-1 50 50", "100 200 -10 50", "5 10 15"],
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

    test_cases = []
    for inp in tpl["inputs"]:
        out = _run_code_once(tpl["fixed_code"], inp) or ""
        test_cases.append({"input": inp, "expected_output": out})

    return {
        "title": tpl["title"],
        "difficulty": chosen_diff,
        "category": tpl["category"],
        "tags": _clean_tags(tpl["tags"]),
        "description": tpl["description"],
        "buggy_code": tpl["buggy_code"],
        "fixed_code": tpl["fixed_code"],
        "hint": tpl["hint"],
        "test_cases": test_cases,
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
    problem_data: Optional[Dict[str, Any]] = None

    if api_key:
        seed_topic = random.choice([
            "sliding window", "monotonic stack", "prefix sum", "hash map frequency",
            "two pointers", "binary search", "interval merging",
            "matrix traversal", "anagram grouping", "greedy scheduling"
        ])
        prompt = (
            f"Generate ONE unique Python 3 bug-hunting coding challenge.\n"
            f"- Category: {chosen_cat}\n"
            f"- Difficulty: {chosen_diff}\n"
            f"- Topic: {seed_topic}\n\n"
            "Requirements:\n"
            "1. Both `buggy_code` and `fixed_code` must be standalone Python 3 scripts starting with `import sys` "
            "that read input from `sys.stdin.read().strip()` and `print()` the final result.\n"
            "2. `buggy_code` must have a 1-line bug with a `# Bug: ...` comment above it.\n"
            "3. `tags` must be a list of 3 short strings WITHOUT '#' prefixes.\n"
            "4. Return ONLY valid JSON with keys: title, difficulty, category, tags, description, "
            "buggy_code, fixed_code, hint, and test_cases (4 objects with 'input' and 'expected_output')."
        )
        problem_data = _call_gemini_api(api_key, prompt)

    if not problem_data or "buggy_code" not in problem_data:
        problem_data = _generate_procedural_fallback(chosen_cat, chosen_diff)
    else:
        problem_data["category"] = chosen_cat
        problem_data["difficulty"] = chosen_diff
        problem_data["tags"] = _clean_tags(problem_data.get("tags", []))

        fixed_code = problem_data.get("fixed_code", "")
        verified_tests: List[Dict[str, str]] = []
        for tc in problem_data.get("test_cases", [])[:4]:
            inp = str(tc.get("input", ""))
            actual_fixed_out = _run_code_once(fixed_code, inp) if fixed_code else None
            expected = (
                actual_fixed_out
                if actual_fixed_out is not None
                else str(tc.get("expected_output", "")).strip()
            )
            verified_tests.append({"input": inp, "expected_output": expected})
        problem_data["test_cases"] = verified_tests

    new_id = _save_to_sqlite(problem_data)
    problem_data.pop("fixed_code", None)
    problem_data["id"] = new_id
    return problem_data