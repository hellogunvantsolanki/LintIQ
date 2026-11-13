# Curated problem bank organized by domain category

OFF_BY_ONE_PROBLEMS = [
    {
        "title": "Sum of First N Natural Numbers",
        "description": "Write a Python program that reads a single integer N from standard input and prints the sum of all natural numbers from 1 up to N (inclusive). For example, if N is 3, the output should be 6.",
        "difficulty": "Easy",
        "category": "Off-by-One",
        "tags": ["range-bounds", "loops", "math"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    n_str = sys.stdin.read().strip()\n"
            "    if not n_str:\n"
            "        return\n"
            "    n = int(n_str)\n"
            "    # Bug: Off-by-one upper bound in range()\n"
            "    current_sum = sum(range(1, n))\n"
            "    print(current_sum)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "3", "expected_output": "6"},
            {"input": "5", "expected_output": "15"},
            {"input": "1", "expected_output": "1"},
            {"input": "10", "expected_output": "55"}
        ],
        "hint": "Check the stop value of range(start, stop). In Python, range(1, n) stops at n - 1."
    },
    {
        "title": "Binary Search Boundary Trap",
        "description": "Given a sorted line of space-separated integers on line 1 and a target integer on line 2, print the 0-based index of the target in the list. If the target does not exist, print -1.",
        "difficulty": "Easy",
        "category": "Off-by-One",
        "tags": ["binary-search", "pointers", "arrays"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def binary_search():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    nums = list(map(int, lines[0].split()))\n"
            "    target = int(lines[1].strip())\n\n"
            "    low = 0\n"
            "    high = len(nums) - 1\n"
            "    # Bug: Boundary condition misses single-element or edge matches\n"
            "    while low < high:\n"
            "        mid = (low + high) // 2\n"
            "        if nums[mid] == target:\n"
            "            print(mid)\n"
            "            return\n"
            "        elif nums[mid] < target:\n"
            "            low = mid + 1\n"
            "        else:\n"
            "            high = mid - 1\n"
            "    print(-1)\n\n"
            "binary_search()\n"
        ),
        "test_cases": [
            {"input": "1 3 5 7 9\n9", "expected_output": "4"},
            {"input": "2 4 6 8\n2", "expected_output": "0"},
            {"input": "10\n10", "expected_output": "0"},
            {"input": "1 2 3 4\n5", "expected_output": "-1"}
        ],
        "hint": "When low and high converge on the target index, low == high. What happens with 'while low < high'?"
    }
]

EDGE_CASES_PROBLEMS = [
    {
        "title": "Sum of Absolute Digits",
        "description": "Read an integer string from standard input and print the sum of the absolute values of its digits. For example, if the input is '-45', the sum is 4 + 5 = 9. If the input is '0', the sum is 0.",
        "difficulty": "Easy",
        "category": "Edge Cases",
        "tags": ["negative-numbers", "modulo", "math"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def sum_absolute_digits(n_str):\n"
            "    # Bug: Negative integers bypass the > 0 loop\n"
            "    n = int(n_str)\n"
            "    total_sum = 0\n"
            "    while n > 0:\n"
            "        digit = n % 10\n"
            "        total_sum += digit\n"
            "        n //= 10\n"
            "    return total_sum\n\n"
            "line = sys.stdin.readline().strip()\n"
            "if line:\n"
            "    print(sum_absolute_digits(line))\n"
        ),
        "test_cases": [
            {"input": "123", "expected_output": "6"},
            {"input": "-45", "expected_output": "9"},
            {"input": "0", "expected_output": "0"},
            {"input": "-7", "expected_output": "7"}
        ],
        "hint": "Convert the parsed integer to its non-negative magnitude using abs() before extracting digits."
    },
    {
        "title": "Maximum Product of Two Distinct Numbers",
        "description": "Given a single line of space-separated integers (at least two), find and print the maximum product that can be obtained by multiplying any two numbers at different positions in the list.",
        "difficulty": "Medium",
        "category": "Edge Cases",
        "tags": ["negative-values", "sorting", "arrays"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    line = sys.stdin.readline().strip()\n"
            "    if not line:\n"
            "        return\n"
            "    nums = list(map(int, line.split()))\n"
            "    nums.sort()\n"
            "    # Bug: Ignores that two negative numbers multiply to a positive product\n"
            "    max_product = nums[-1] * nums[-2]\n"
            "    print(max_product)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "5 20 2 3", "expected_output": "100"},
            {"input": "-10 -20 1 2", "expected_output": "200"},
            {"input": "-5 -4 -3 -2 -1", "expected_output": "20"},
            {"input": "-10 10 5", "expected_output": "50"},
            {"input": "5 5", "expected_output": "25"}
        ],
        "hint": "After sorting, the two largest negative values sit at indices 0 and 1. Compare nums[0] * nums[1] with nums[-1] * nums[-2]."
    }
]

ALGORITHMS_PROBLEMS = [
    {
        "title": "Two Sum in Sorted Array",
        "description": "Given a sorted line of space-separated integers on line 1 and a target integer on line 2, find the 0-based indices i and j (i < j) whose elements sum to the target. Print 'i j', or '-1' if no pair exists.",
        "difficulty": "Easy",
        "category": "Algorithms",
        "tags": ["two-pointers", "arrays", "search"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    nums = list(map(int, lines[0].split()))\n"
            "    target = int(lines[1].strip())\n\n"
            "    left, right = 0, len(nums) - 1\n"
            "    while left < right:\n"
            "        curr = nums[left] + nums[right]\n"
            "        if curr == target:\n"
            "            print(f'{left} {right}')\n"
            "            return\n"
            "        # Bug: Pointers move in the wrong direction\n"
            "        elif curr < target:\n"
            "            right -= 1\n"
            "        else:\n"
            "            left += 1\n"
            "    print(-1)\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "2 7 11 15\n9", "expected_output": "0 1"},
            {"input": "1 3 4 6 8 11\n10", "expected_output": "2 3"},
            {"input": "1 2 3 9\n15", "expected_output": "-1"},
            {"input": "-5 -2 0 3 7\n1", "expected_output": "1 3"}
        ],
        "hint": "Since the array is sorted in ascending order, increasing the sum requires advancing 'left', and decreasing the sum requires decrementing 'right'."
    },
    {
        "title": "Kadane's Maximum Subarray Sum",
        "description": "Given a line of space-separated integers, find the contiguous non-empty subarray with the largest sum and print that sum.",
        "difficulty": "Medium",
        "category": "Algorithms",
        "tags": ["dynamic-programming", "greedy", "arrays"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def max_subarray():\n"
            "    line = sys.stdin.read().strip()\n"
            "    if not line:\n"
            "        return\n"
            "    nums = list(map(int, line.split()))\n\n"
            "    # Bug: Initializing to 0 fails when all elements are negative\n"
            "    max_so_far = 0\n"
            "    curr_max = 0\n"
            "    for x in nums:\n"
            "        curr_max = max(x, curr_max + x)\n"
            "        max_so_far = max(max_so_far, curr_max)\n"
            "    print(max_so_far)\n\n"
            "max_subarray()\n"
        ),
        "test_cases": [
            {"input": "-2 1 -3 4 -1 2 1 -5 4", "expected_output": "6"},
            {"input": "-5 -2 -9 -4", "expected_output": "-2"},
            {"input": "5 4 -1 7 8", "expected_output": "23"},
            {"input": "-10", "expected_output": "-10"}
        ],
        "hint": "Initialize both 'max_so_far' and 'curr_max' to nums[0] and iterate through nums[1:]."
    }
]

DATA_STRUCTURES_PROBLEMS = [
    {
        "title": "Valid Parentheses Matcher",
        "description": "Given a string containing only '(', ')', '{', '}', '[' and ']', print True if the input string is valid and all brackets are properly closed and nested, or False otherwise.",
        "difficulty": "Easy",
        "category": "Data Structures",
        "tags": ["stack", "strings", "parsing"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def is_valid(s):\n"
            "    stack = []\n"
            "    pairs = {')': '(', '}': '{', ']': '['}\n"
            "    for ch in s:\n"
            "        if ch in pairs:\n"
            "            if not stack or stack[-1] != pairs[ch]:\n"
            "                return False\n"
            "            stack.pop()\n"
            "        else:\n"
            "            stack.append(ch)\n"
            "    # Bug: Ignores leftover unclosed opening brackets on the stack\n"
            "    return True\n\n"
            "s = sys.stdin.readline().strip()\n"
            "print(is_valid(s))\n"
        ),
        "test_cases": [
            {"input": "()[]{}", "expected_output": "True"},
            {"input": "([{}])", "expected_output": "True"},
            {"input": "(((", "expected_output": "False"},
            {"input": "([)]", "expected_output": "False"},
            {"input": "(([])", "expected_output": "False"}
        ],
        "hint": "At the end of iteration, the string is only valid if the stack is completely empty (len(stack) == 0)."
    },
    {
        "title": "First Non-Repeating Character Index",
        "description": "Given a lowercase string s, find the first character that does not repeat anywhere in the string and print its 0-based index. If every character repeats, print -1.",
        "difficulty": "Easy",
        "category": "Data Structures",
        "tags": ["hash-map", "frequency-count", "strings"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def first_uniq_char(s):\n"
            "    counts = {}\n"
            "    for ch in s:\n"
            "        # Bug: Overwrites frequency with 1 instead of incrementing\n"
            "        counts[ch] = 1\n\n"
            "    for idx, ch in enumerate(s):\n"
            "        if counts[ch] == 1:\n"
            "            return idx\n"
            "    return -1\n\n"
            "s = sys.stdin.readline().strip()\n"
            "print(first_uniq_char(s))\n"
        ),
        "test_cases": [
            {"input": "lintiq", "expected_output": "0"},
            {"input": "loveleetcode", "expected_output": "2"},
            {"input": "aabb", "expected_output": "-1"},
            {"input": "z", "expected_output": "0"}
        ],
        "hint": "Use counts[ch] = counts.get(ch, 0) + 1 so repeated characters increment above 1."
    }
]

TYPE_COERCION_PROBLEMS = [
    {
        "title": "Lexicographical vs Numeric Sort Trap",
        "description": "Read a single line of space-separated integers, sort them in ascending numerical order, and print them separated by spaces.",
        "difficulty": "Easy",
        "category": "Type Coercion",
        "tags": ["sorting", "type-casting", "strings"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def solve():\n"
            "    line = sys.stdin.readline().strip()\n"
            "    if not line:\n"
            "        return\n"
            "    # Bug: Sorting raw strings orders '10' before '9' ASCII-wise\n"
            "    items = line.split()\n"
            "    items.sort()\n"
            "    print(' '.join(items))\n\n"
            "solve()\n"
        ),
        "test_cases": [
            {"input": "18 10 12 9 15 11", "expected_output": "9 10 11 12 15 18"},
            {"input": "100 2 30 4", "expected_output": "2 4 30 100"},
            {"input": "-5 -10 0 2", "expected_output": "-10 -5 0 2"}
        ],
        "hint": "Convert each token to int before sorting (or pass key=int to sort)."
    },
    {
        "title": "Boolean Flag Truthiness Trap",
        "description": "Given a line of space-separated flag strings ('true', 'false', '1', '0', case-insensitive), count and print how many flags represent an enabled/true state ('true' or '1').",
        "difficulty": "Medium",
        "category": "Type Coercion",
        "tags": ["booleans", "truthiness", "parsing"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def count_enabled():\n"
            "    tokens = sys.stdin.read().strip().split()\n"
            "    count = 0\n"
            "    for t in tokens:\n"
            "        # Bug: bool('false') and bool('0') are True in Python!\n"
            "        if bool(t):\n"
            "            count += 1\n"
            "    print(count)\n\n"
            "count_enabled()\n"
        ),
        "test_cases": [
            {"input": "true false true", "expected_output": "2"},
            {"input": "false 0 false", "expected_output": "0"},
            {"input": "1 0 True FALSE 1", "expected_output": "3"},
            {"input": "TRUE", "expected_output": "1"}
        ],
        "hint": "In Python, any non-empty string is truthy. Explicitly check if t.lower() in ('true', '1')."
    }
]

MEMORY_STATE_PROBLEMS = [
    {
        "title": "Mutable Default Argument State Leak",
        "description": "Read multiple lines of space-separated words. For each line independently, count how many unique words appear on that line and print the counts space-separated on a single line.",
        "difficulty": "Medium",
        "category": "Memory & State",
        "tags": ["mutable-defaults", "state-leak", "functions"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "# Bug: Mutable default list 'bucket' retains elements across calls!\n"
            "def count_line_unique(words, bucket=[]):\n"
            "    for w in words:\n"
            "        if w not in bucket:\n"
            "            bucket.append(w)\n"
            "    return len(bucket)\n\n"
            "lines = sys.stdin.read().strip().splitlines()\n"
            "results = [str(count_line_unique(line.split())) for line in lines if line.strip()]\n"
            "print(' '.join(results))\n"
        ),
        "test_cases": [
            {"input": "apple banana\nbanana cherry", "expected_output": "2 2"},
            {"input": "a a a\nb c", "expected_output": "1 2"},
            {"input": "x y\nx y\nz", "expected_output": "2 2 1"}
        ],
        "hint": "Default arguments in Python are evaluated once when the function is defined. Initialize bucket = None and create a new list inside the function."
    },
    {
        "title": "Shallow Copy Matrix Aliasing Bug",
        "description": "Read an integer N. Construct an N x N identity matrix where diagonal cells grid[i][i] = 1 and all other cells are 0. Print the sum of the first row and the sum of all cells in the matrix, space-separated.",
        "difficulty": "Medium",
        "category": "Memory & State",
        "tags": ["references", "aliasing", "2d-lists"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def build_identity():\n"
            "    line = sys.stdin.read().strip()\n"
            "    if not line:\n"
            "        return\n"
            "    n = int(line)\n"
            "    # Bug: Multiplying a nested list aliases the exact same row reference\n"
            "    grid = [[0] * n] * n\n"
            "    for i in range(n):\n"
            "        grid[i][i] = 1\n\n"
            "    first_row_sum = sum(grid[0])\n"
            "    total_sum = sum(sum(r) for r in grid)\n"
            "    print(f'{first_row_sum} {total_sum}')\n\n"
            "build_identity()\n"
        ),
        "test_cases": [
            {"input": "3", "expected_output": "1 3"},
            {"input": "1", "expected_output": "1 1"},
            {"input": "4", "expected_output": "1 4"},
            {"input": "5", "expected_output": "1 5"}
        ],
        "hint": "Use a list comprehension [[0] * n for _ in range(n)] so each row is a distinct list object in memory."
    }
]

CONCURRENCY_PROBLEMS = [
    {
        "title": "Atomic Balance Check-Then-Act Trap",
        "description": "Line 1 contains an initial account balance (integer). Line 2 contains space-separated signed transactions (e.g. '-60 -60 20'). Process transactions in order: a withdrawal (negative value) must only be applied if the live running balance will not drop below 0. Print the final balance.",
        "difficulty": "Hard",
        "category": "Concurrency",
        "tags": ["race-condition", "toctou", "state-consistency"],
        "language": "python",
        "buggy_code": (
            "import sys\n\n"
            "def process_ledger():\n"
            "    lines = sys.stdin.read().strip().splitlines()\n"
            "    if len(lines) < 2:\n"
            "        return\n"
            "    balance = int(lines[0].strip())\n"
            "    txs = list(map(int, lines[1].split()))\n\n"
            "    # Bug: Validates all withdrawals against a stale snapshot of balance (TOCTOU)\n"
            "    snapshot_balance = balance\n"
            "    approved_txs = [tx for tx in txs if snapshot_balance + tx >= 0]\n\n"
            "    for tx in approved_txs:\n"
            "        balance += tx\n"
            "    print(balance)\n\n"
            "process_ledger()\n"
        ),
        "test_cases": [
            {"input": "100\n-60 -60 20", "expected_output": "60"},
            {"input": "50\n-30 -20 -10", "expected_output": "0"},
            {"input": "10\n-20 50 -30", "expected_output": "30"},
            {"input": "0\n-10 25 -15", "expected_output": "10"}
        ],
        "hint": "Check and update the live 'balance' atomically inside a single sequential loop rather than pre-filtering against a stale snapshot."
    }
]

CURATED_PROBLEMS = (
    OFF_BY_ONE_PROBLEMS
    + EDGE_CASES_PROBLEMS
    + ALGORITHMS_PROBLEMS
    + DATA_STRUCTURES_PROBLEMS
    + TYPE_COERCION_PROBLEMS
    + MEMORY_STATE_PROBLEMS
    + CONCURRENCY_PROBLEMS
)