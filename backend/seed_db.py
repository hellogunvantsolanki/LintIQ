import os
import sys
import time
import sqlite3

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from database import init_db, DB_PATH
from ai_generator import generate_ai_bug_challenge as generate_single_problem

# How many problems total do you want in your database?
TOTAL_GOAL = 1000

# Pause between API requests to stay within free-tier limits (15 requests/minute)
DELAY_SECONDS = 4


def count_problems():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM problems")
    total = cursor.fetchone()[0]
    conn.close()
    return total


def main():
    # Ensure database table exists
    init_db()

    current_count = count_problems()
    print("=== LintIQ Database Builder ===", flush=True)
    print(f"Current problems in database: {current_count}", flush=True)
    print(f"Target goal: {TOTAL_GOAL}", flush=True)
    print("Starting continuous generation. Press Ctrl + C anytime to stop.\n", flush=True)

    added_this_session = 0

    while current_count < TOTAL_GOAL:
        print(f"[{current_count + 1}/{TOTAL_GOAL}] Requesting and validating challenge...", flush=True)
        try:
            prob = generate_single_problem()
            current_count += 1
            added_this_session += 1
            title = prob.get("title", "Untitled") if isinstance(prob, dict) else getattr(prob, "title", "Untitled")
            diff = prob.get("difficulty", "Medium") if isinstance(prob, dict) else getattr(prob, "difficulty", "Medium")
            print(f"  -> SAVED: '{title}' ({diff}) | Total in DB: {current_count}", flush=True)
        except Exception as e:
            print(f"  -> Skipped (Failed validation or API issue): {e}", flush=True)

        # Wait to avoid hitting API rate limits
        time.sleep(DELAY_SECONDS)

    print(f"\nDone! Added {added_this_session} new challenges to problems.db.", flush=True)


if __name__ == "__main__":
    main()