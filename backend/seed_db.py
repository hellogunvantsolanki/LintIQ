import os
import sys
import time
import sqlite3
from main import generate_single_problem, init_db, DB_PATH

# Ensure database table exists
init_db()

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

current_count = count_problems()
print(f"=== LintIQ Database Builder ===")
print(f"Current problems in database: {current_count}")
print(f"Target goal: {TOTAL_GOAL}")
print("Starting continuous generation. Press Ctrl + C anytime to stop.\n")

added_this_session = 0

while current_count < TOTAL_GOAL:
    print(f"[{current_count + 1}/{TOTAL_GOAL}] Requesting and validating challenge...")
    try:
        prob = generate_single_problem()
        current_count += 1
        added_this_session += 1
        print(f"  -> SAVED: '{prob.title}' ({prob.difficulty}) | Total in DB: {current_count}")
    except Exception as e:
        print(f"  -> Skipped (Failed validation or API issue): {e}")

    # Wait to avoid hitting Google's rate limits
    time.sleep(DELAY_SECONDS)

print(f"\nDone! Added {added_this_session} new challenges to problems.db.")