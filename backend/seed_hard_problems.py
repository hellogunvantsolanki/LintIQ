import json
import sqlite3

DB_PATH = "problems.db"

NEW_PROBLEMS = [
    {
        "title": "LRU Cache Recency Eviction Bug",
        "description": (
            "Simulate an LRU Cache with integer capacity C (line 1). Each following line is "
            "'PUT key value' or 'GET key'. For every GET, print the cached value (or -1 if absent), "
            "space-separated on one line."
        ),
        "difficulty": "Hard",
        "category": "Data Structures",
        "tags": ["lru-cache", "ordered-dict", "eviction"],
        "hint": "Reading an existing key with GET also counts as recently using it.",
        "buggy_code": (
            "import sys\n"
            "from collections import OrderedDict\n\n"
            "def solve():\n"
            "    lines = [l.strip() for l in sys.stdin.read().strip().splitlines() if l.strip()]\n"
            "    if not lines:\n"
            "        return\n"
            "    cap = int(lines[0])\n"
            "    cache = OrderedDict()\n"
            "    out = []\n\n"
            "    for line in lines[1:]:\n"
            "        parts = line.split()\n"
            "        if parts[0] == 'PUT':\n"
            "            k, v = int(parts[1]), int(parts[2])\n"
            "            cache[k] = v\n"
            "            cache.move_to_end(k)\n"
            "            if len(cache) > cap:\n"
            "                cache.popitem(last=False)\n"
            "        elif parts[0] == 'GET':\n"
            "            k = int(parts[1])\n"
            "            if k in cache:\n"
            "                out.append(str(cache[k]))\n"
            "            else:\n"
            "                out.append('-1')\n"
            "    print(' '.join(out))\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "2\nPUT 1 10\nPUT 2 20\nGET 1\nPUT 3 30\nGET 2\nGET 1", "expected_output": "10 -1 10"},
            {"input": "2\nPUT 1 1\nPUT 2 2\nPUT 1 10\nPUT 3 3\nGET 2\nGET 1", "expected_output": "-1 10"},
            {"input": "1\nPUT 5 50\nGET 5\nPUT 6 60\nGET 5\nGET 6", "expected_output": "50 -1 60"},
            {"input": "2\nGET 9\nPUT 9 99\nGET 9", "expected_output": "-1 99"},
        ],
    },
    {
        "title": "Dijkstra Premature Visited Lockout",
        "description": (
            "Given a weighted directed graph with N nodes (0 to N-1) and M edges (line 1: 'N M', "
            "followed by M lines of 'u v w' with w >= 0), print the shortest distance from node 0 "
            "to node N-1, or -1 if unreachable."
        ),
        "difficulty": "Hard",
        "category": "Algorithms",
        "tags": ["dijkstra", "shortest-path", "heap", "graphs"],
        "hint": "Marking a node as visited when pushing to the heap prevents shorter multi-hop paths from relaxing it later.",
        "buggy_code": (
            "import sys\n"
            "import heapq\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if not lines:\n"
            "        return\n"
            "    n, m = map(int, lines[0].split())\n"
            "    adj = [[] for _ in range(n)]\n"
            "    for line in lines[1:m + 1]:\n"
            "        u, v, w = map(int, line.split())\n"
            "        adj[u].append((v, w))\n\n"
            "    pq = [(0, 0)]\n"
            "    visited = {0}\n"
            "    while pq:\n"
            "        d, u = heapq.heappop(pq)\n"
            "        if u == n - 1:\n"
            "            print(d)\n"
            "            return\n"
            "        for v, w in adj[u]:\n"
            "            if v not in visited:\n"
            "                visited.add(v)\n"
            "                heapq.heappush(pq, (d + w, v))\n"
            "    print(-1)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "4 4\n0 3 10\n0 1 1\n1 2 1\n2 3 1", "expected_output": "3"},
            {"input": "3 3\n0 2 5\n0 1 2\n1 2 2", "expected_output": "4"},
            {"input": "3 1\n0 1 4", "expected_output": "-1"},
            {"input": "5 6\n0 4 100\n0 1 2\n1 2 3\n2 3 4\n3 4 5\n0 2 10", "expected_output": "14"},
        ],
    },
    {
        "title": "0/1 Knapsack In-Place State Reuse",
        "description": (
            "Line 1 contains knapsack capacity W. Each subsequent line contains 'weight value' for an item. "
            "Each item can be picked at most once. Print the maximum total value achievable without exceeding W."
        ),
        "difficulty": "Hard",
        "category": "Algorithms",
        "tags": ["dynamic-programming", "knapsack", "1d-dp"],
        "hint": "Check the direction of the capacity loop. Iterating forward reuses states already updated by the same item.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = [l.strip() for l in sys.stdin.read().strip().splitlines() if l.strip()]\n"
            "    if not lines:\n"
            "        return\n"
            "    W = int(lines[0])\n"
            "    items = [tuple(map(int, l.split())) for l in lines[1:]]\n\n"
            "    dp = [0] * (W + 1)\n"
            "    for w, v in items:\n"
            "        for cap in range(w, W + 1):\n"
            "            dp[cap] = max(dp[cap], dp[cap - w] + v)\n"
            "    print(dp[W])\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "6\n2 5\n4 7", "expected_output": "12"},
            {"input": "4\n2 10\n3 11", "expected_output": "11"},
            {"input": "10\n5 10\n4 40\n6 30\n3 50", "expected_output": "90"},
            {"input": "3\n4 100\n5 200", "expected_output": "0"},
        ],
    },
    {
        "title": "Directed Graph Cycle False Positive on DAG",
        "description": (
            "Line 1 contains 'N M' (nodes 0..N-1 and M directed edges). Next M lines contain 'u v'. "
            "Print 'CYCLE' if the directed graph contains at least one cycle, otherwise print 'ACYCLIC'."
        ),
        "difficulty": "Hard",
        "category": "Data Structures",
        "tags": ["graphs", "dfs", "cycle-detection", "dag"],
        "hint": "A single visited set cannot distinguish between an active recursion-stack ancestor and an already-finished node in a diamond DAG.",
        "buggy_code": (
            "import sys\n"
            "sys.setrecursionlimit(20000)\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if not lines:\n"
            "        return\n"
            "    n, m = map(int, lines[0].split())\n"
            "    adj = [[] for _ in range(n)]\n"
            "    for line in lines[1:m + 1]:\n"
            "        u, v = map(int, line.split())\n"
            "        adj[u].append(v)\n\n"
            "    visited = set()\n\n"
            "    def has_cycle(u):\n"
            "        visited.add(u)\n"
            "        for v in adj[u]:\n"
            "            if v in visited or has_cycle(v):\n"
            "                return True\n"
            "        return False\n\n"
            "    for i in range(n):\n"
            "        if i not in visited and has_cycle(i):\n"
            "            print('CYCLE')\n"
            "            return\n"
            "    print('ACYCLIC')\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "4 4\n0 1\n0 2\n1 3\n2 3", "expected_output": "ACYCLIC"},
            {"input": "3 3\n0 1\n1 2\n2 0", "expected_output": "CYCLE"},
            {"input": "4 3\n0 1\n2 3\n3 2", "expected_output": "CYCLE"},
            {"input": "4 3\n0 1\n1 2\n2 3", "expected_output": "ACYCLIC"},
        ],
    },
    {
        "title": "Rotated Sorted Array Two-Element Pivot Trap",
        "description": (
            "Line 1 contains a rotated sorted array of distinct integers. Line 2 contains a target integer. "
            "Print the 0-based index of the target, or -1 if it is not present."
        ),
        "difficulty": "Hard",
        "category": "Off-by-One",
        "tags": ["binary-search", "rotated-array", "boundary"],
        "hint": "Trace what happens when lo == mid (a 2-element subarray) with strict '<' vs '<='.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    nums = list(map(int, lines[0].split()))\n"
            "    target = int(lines[1].strip())\n"
            "    lo, hi = 0, len(nums) - 1\n\n"
            "    while lo <= hi:\n"
            "        mid = (lo + hi) // 2\n"
            "        if nums[mid] == target:\n"
            "            print(mid)\n"
            "            return\n"
            "        if nums[lo] < nums[mid]:\n"
            "            if nums[lo] <= target < nums[mid]:\n"
            "                hi = mid - 1\n"
            "            else:\n"
            "                lo = mid + 1\n"
            "        else:\n"
            "            if nums[mid] < target <= nums[hi]:\n"
            "                lo = mid + 1\n"
            "            else:\n"
            "                hi = mid - 1\n"
            "    print(-1)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "3 1\n1", "expected_output": "1"},
            {"input": "2 1\n1", "expected_output": "1"},
            {"input": "4 5 6 7 0 1 2\n0", "expected_output": "4"},
            {"input": "4 5 6 7 0 1 2\n3", "expected_output": "-1"},
            {"input": "5 1 3\n3", "expected_output": "2"},
        ],
    },
    {
        "title": "Late-Binding Closure Multiplier Queue",
        "description": (
            "Line 1 contains space-separated integer multipliers. Line 2 contains an integer X. "
            "Build a callback list applying each multiplier to X and print the results space-separated."
        ),
        "difficulty": "Hard",
        "category": "Memory & State",
        "tags": ["closures", "late-binding", "lambdas", "scope"],
        "hint": "Lambdas created inside a loop capture the loop variable by reference, not by its value at creation time.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    factors = list(map(int, lines[0].split()))\n"
            "    x = int(lines[1].strip())\n\n"
            "    callbacks = [lambda v: v * f for f in factors]\n"
            "    print(' '.join(str(fn(x)) for fn in callbacks))\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "2 3 5\n10", "expected_output": "20 30 50"},
            {"input": "1 0 -2\n4", "expected_output": "4 0 -8"},
            {"input": "7\n6", "expected_output": "42"},
            {"input": "10 20 30 40\n2", "expected_output": "20 40 60 80"},
        ],
    },
    {
        "title": "Token Bucket Rate Limiter Precision & Cap Bug",
        "description": (
            "Simulate a token bucket rate limiter. Line 1: 'capacity refill_per_sec' (floats). "
            "Subsequent lines: 'timestamp cost' (non-decreasing floats). Starting full at the first request, "
            "refill elapsed * refill_per_sec (capped at capacity). If tokens >= cost (within 1e-9 tolerance), "
            "deduct cost and output ALLOW, else DENY. Print verdicts space-separated."
        ),
        "difficulty": "Hard",
        "category": "Type Coercion",
        "tags": ["rate-limiter", "floating-point", "precision", "truncation"],
        "hint": "Avoid truncating fractional refills with int(), cap tokens at capacity, and include a 1e-9 epsilon tolerance for float comparisons.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = [l.strip() for l in sys.stdin.read().strip().splitlines() if l.strip()]\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    cap, refill = map(float, lines[0].split())\n"
            "    reqs = [tuple(map(float, l.split())) for l in lines[1:]]\n\n"
            "    tokens = cap\n"
            "    last_ts = reqs[0][0]\n"
            "    out = []\n\n"
            "    for ts, cost in reqs:\n"
            "        elapsed = ts - last_ts\n"
            "        tokens = tokens + int(elapsed * refill)\n"
            "        last_ts = ts\n"
            "        if tokens >= cost:\n"
            "            tokens -= cost\n"
            "            out.append('ALLOW')\n"
            "        else:\n"
            "            out.append('DENY')\n"
            "    print(' '.join(out))\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "1.0 0.5\n0.0 1.0\n0.6 0.3\n1.2 0.3", "expected_output": "ALLOW ALLOW ALLOW"},
            {"input": "2.0 1.0\n0.0 1.0\n10.0 2.0\n10.0 1.0", "expected_output": "ALLOW ALLOW DENY"},
            {"input": "0.3 0.0\n0.0 0.1\n0.0 0.2", "expected_output": "ALLOW ALLOW"},
            {"input": "3.0 0.5\n0.0 2.0\n1.0 2.0\n3.0 2.0", "expected_output": "ALLOW DENY ALLOW"},
        ],
    },
    {
        "title": "Optimistic Concurrency (CAS) Version Corruption",
        "description": (
            "Simulate an atomic ledger using Optimistic Concurrency Control. Line 1 is the initial balance "
            "(starting at version 0). Each subsequent line is 'expected_version delta'. A transaction commits "
            "(updating balance and incrementing version by 1) ONLY if expected_version == current_version AND "
            "balance + delta >= 0. Aborted transactions must leave balance and version untouched. "
            "Print 'final_balance final_version'."
        ),
        "difficulty": "Hard",
        "category": "Concurrency",
        "tags": ["optimistic-locking", "cas", "transactions", "atomicity"],
        "hint": "An aborted transaction must not bump the version counter.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = [l.strip() for l in sys.stdin.read().strip().splitlines() if l.strip()]\n"
            "    if not lines:\n"
            "        return\n"
            "    balance = int(lines[0])\n"
            "    version = 0\n\n"
            "    for line in lines[1:]:\n"
            "        exp_ver, delta = map(int, line.split())\n"
            "        if exp_ver == version and balance + delta >= 0:\n"
            "            balance += delta\n"
            "            version += 1\n"
            "        else:\n"
            "            version += 1\n"
            "    print(f'{balance} {version}')\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "100\n0 -150\n0 -40\n1 20", "expected_output": "80 2"},
            {"input": "50\n0 50\n0 -30\n1 -30", "expected_output": "70 2"},
            {"input": "0\n0 -10\n0 -5\n0 25", "expected_output": "25 1"},
            {"input": "200\n0 -50\n1 -50\n2 -150\n2 -100", "expected_output": "0 3"},
        ],
    },
    {
        "title": "Nested Interval Merge Shrink Bug",
        "description": (
            "Each line contains 'start end' of an interval. Merge all overlapping or touching intervals "
            "and print the merged intervals sorted by start time as 'start-end' separated by spaces."
        ),
        "difficulty": "Medium",
        "category": "Edge Cases",
        "tags": ["intervals", "sorting", "merging"],
        "hint": "What happens when a shorter interval is completely contained inside the previous merged interval?",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = [l.strip() for l in sys.stdin.read().strip().splitlines() if l.strip()]\n"
            "    if not lines:\n"
            "        return\n"
            "    intervals = [list(map(int, l.split())) for l in lines]\n"
            "    intervals.sort()\n"
            "    merged = [intervals[0]]\n"
            "    for s, e in intervals[1:]:\n"
            "        if s <= merged[-1][1]:\n"
            "            merged[-1][1] = e\n"
            "        else:\n"
            "            merged.append([s, e])\n"
            "    print(' '.join(f'{s}-{e}' for s, e in merged))\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "1 10\n2 5\n6 8", "expected_output": "1-10"},
            {"input": "1 3\n2 6\n8 10\n15 18", "expected_output": "1-6 8-10 15-18"},
            {"input": "1 4\n4 5", "expected_output": "1-5"},
            {"input": "5 12\n1 20\n3 7", "expected_output": "1-20"},
        ],
    },
    {
        "title": "Minimum Size Subarray Single-Shrink Bug",
        "description": (
            "Line 1 is a positive integer target. Line 2 is space-separated positive integers. "
            "Print the minimal length of a contiguous subarray whose sum is >= target, or 0 if none exists."
        ),
        "difficulty": "Medium",
        "category": "Off-by-One",
        "tags": ["sliding-window", "two-pointers", "subarray"],
        "hint": "Shrinking the window only once per right-pointer step misses shorter valid subarrays inside the current window.",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    target = int(lines[0].strip())\n"
            "    nums = list(map(int, lines[1].split()))\n\n"
            "    left = 0\n"
            "    curr = 0\n"
            "    best = float('inf')\n"
            "    for right, val in enumerate(nums):\n"
            "        curr += val\n"
            "        if curr >= target:\n"
            "            best = min(best, right - left + 1)\n"
            "            curr -= nums[left]\n"
            "            left += 1\n"
            "    print(0 if best == float('inf') else best)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "7\n2 3 1 2 4 3", "expected_output": "2"},
            {"input": "11\n1 1 1 1 1 1 1 1", "expected_output": "0"},
            {"input": "4\n1 4 4", "expected_output": "1"},
            {"input": "15\n1 2 3 4 5 15", "expected_output": "1"},
        ],
    },
]


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # 1. Normalize inconsistent difficulty casing across existing rows
    cur.execute("UPDATE problems SET difficulty = 'Easy' WHERE LOWER(difficulty) = 'easy'")
    cur.execute("UPDATE problems SET difficulty = 'Medium' WHERE LOWER(difficulty) = 'medium'")
    cur.execute("UPDATE problems SET difficulty = 'Hard' WHERE LOWER(difficulty) = 'hard'")

    # 2. Insert new Hard & Medium problems (skip if title already exists)
    inserted = 0
    for p in NEW_PROBLEMS:
        exists = cur.execute("SELECT 1 FROM problems WHERE title = ?", (p["title"],)).fetchone()
        if exists:
            continue
        cur.execute(
            """
            INSERT INTO problems (title, description, difficulty, buggy_code, test_cases, hint, category, tags, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'python')
            """,
            (
                p["title"],
                p["description"],
                p["difficulty"],
                p["buggy_code"],
                json.dumps(p["test_cases"]),
                p["hint"],
                p["category"],
                json.dumps(p["tags"]),
            ),
        )
        inserted += 1

    conn.commit()

    # 3. Print updated difficulty breakdown
    counts = cur.execute(
        "SELECT difficulty, COUNT(DISTINCT title) FROM problems GROUP BY difficulty"
    ).fetchall()
    conn.close()

    print(f"Inserted {inserted} new Medium/Hard problems.")
    print("Unique problems by difficulty:", dict(counts))


if __name__ == "__main__":
    main()
