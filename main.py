import os
import sys
import sqlite3
import subprocess
import tempfile
import json
from typing import List
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="LintIQ Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "problems.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS problems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            difficulty TEXT,
            description TEXT,
            buggy_code TEXT,
            canonical_patch TEXT,
            test_cases TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

class TestCase(BaseModel):
    input_data: str = Field(default="", description="Stdin string")
    expected_output: str = Field(description="Expected stdout string")

class ProblemPayload(BaseModel):
    title: str = Field(description="Title of challenge")
    difficulty: str = Field(description="Easy, Medium, Hard")
    description: str = Field(description="Problem statement and task")
    buggy_code: str = Field(description="Flawed code")
    canonical_patch: str = Field(description="Fixed code")
    test_cases: List[TestCase] = Field(description="Validation test cases")

class SubmitPatchRequest(BaseModel):
    code: str
    test_cases: List[TestCase]

class HintRequest(BaseModel):
    title: str
    description: str
    code: str

def execute_code_sandboxed(code: str, test_cases: List[TestCase], timeout_sec: int = 2):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as tf:
        tf.write(code)
        path = tf.name
    try:
        for idx, tc in enumerate(test_cases):
            proc = subprocess.run(
                [sys.executable, path],
                input=tc.input_data or "",
                text=True,
                capture_output=True,
                timeout=timeout_sec
            )
            if proc.returncode != 0:
                return False, f"Runtime error on test case {idx + 1}: {proc.stderr.strip()}"
            if proc.stdout.strip() != tc.expected_output.strip():
                return False, f"Failed test case {idx + 1}. Expected: {tc.expected_output.strip()} | Got: {proc.stdout.strip()}"
        return True, "All test cases passed."
    except subprocess.TimeoutExpired:
        return False, f"Execution timed out ({timeout_sec}s gate)."
    except Exception as e:
        return False, str(e)
    finally:
        if os.path.exists(path):
            os.remove(path)

def generate_single_problem():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY environment variable is not set.")

    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1beta")
    )

    prompt = (
        "Create a standalone Python programming challenge with exactly one subtle logical bug. "
        "The code must read input from sys.stdin using input() or sys.stdin.read() and print output to stdout. "
        "Ensure standard Python 3 syntax. "
        "Provide: title, difficulty (Easy, Medium, or Hard), description, buggy_code, canonical_patch, and 3 standard input/output test cases."
    )

    models_to_try = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"]
    response = None
    last_error = None

    for m in models_to_try:
        try:
            response = client.models.generate_content(
                model=m,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=ProblemPayload,
                    temperature=0.5
                )
            )
            if response and response.text:
                break
        except Exception as e:
            last_error = e
            continue

    if not response or not response.text:
        raise HTTPException(status_code=500, detail=f"LLM Generation failed: {last_error}")

    try:
        problem_data = json.loads(response.text)
        problem = ProblemPayload(**problem_data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Schema parsing error: {e}")

    # Dual-gate validation
    patch_ok, patch_err = execute_code_sandboxed(problem.canonical_patch, problem.test_cases)
    if not patch_ok:
        raise HTTPException(status_code=500, detail=f"Generated canonical patch failed validation: {patch_err}")

    bug_ok, _ = execute_code_sandboxed(problem.buggy_code, problem.test_cases)
    if bug_ok:
        raise HTTPException(status_code=500, detail="Flawed code passed all tests; not a valid bug.")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO problems (title, difficulty, description, buggy_code, canonical_patch, test_cases)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        problem.title,
        problem.difficulty,
        problem.description,
        problem.buggy_code,
        problem.canonical_patch,
        json.dumps([tc.model_dump() for tc in problem.test_cases])
    ))
    conn.commit()
    conn.close()

    return problem

def background_generate_and_cache():
    try:
        generate_single_problem()
    except Exception:
        pass

@app.get("/get-problem")
def get_problem(background_tasks: BackgroundTasks, exclude_ids: str = Query(default="")):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    excluded = [int(i.strip()) for i in exclude_ids.split(",") if i.strip().isdigit()]

    if excluded:
        placeholders = ",".join("?" for _ in excluded)
        query = f"""
            SELECT id, title, difficulty, description, buggy_code, canonical_patch, test_cases 
            FROM problems 
            WHERE id NOT IN ({placeholders}) 
            ORDER BY RANDOM() LIMIT 1
        """
        cursor.execute(query, excluded)
    else:
        cursor.execute("""
            SELECT id, title, difficulty, description, buggy_code, canonical_patch, test_cases 
            FROM problems 
            ORDER BY RANDOM() LIMIT 1
        """)

    row = cursor.fetchone()

    # Loop back through problems if everything was completed
    if not row:
        cursor.execute("""
            SELECT id, title, difficulty, description, buggy_code, canonical_patch, test_cases 
            FROM problems 
            ORDER BY RANDOM() LIMIT 1
        """)
        row = cursor.fetchone()

    cursor.execute("SELECT COUNT(*) FROM problems")
    total_count = cursor.fetchone()[0]
    conn.close()

    if total_count < 15:
        background_tasks.add_task(background_generate_and_cache)

    if not row:
        return generate_single_problem()

    return {
        "id": row[0],
        "title": row[1],
        "difficulty": row[2],
        "description": row[3],
        "buggy_code": row[4],
        "canonical_patch": row[5],
        "test_cases": json.loads(row[6])
    }

@app.post("/generate-problem")
def generate_problem_endpoint():
    return generate_single_problem()

@app.post("/submit-patch")
def submit_patch(request: SubmitPatchRequest):
    passed, message = execute_code_sandboxed(request.code, request.test_cases)
    return {"passed": passed, "message": message}

@app.post("/get-hint")
def get_hint(req: HintRequest):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not set.")

    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(api_version="v1beta")
    )

    hint_prompt = (
        "You are an arcade code mentor for LintIQ. Provide exactly ONE subtle, concise sentence nudging the developer "
        "toward the logical flaw. DO NOT reveal the answer, DO NOT give direct code snippets, and DO NOT mention line numbers.\n\n"
        f"Problem: {req.title}\n"
        f"Description: {req.description}\n"
        f"Current Code:\n```python\n{req.code}\n```"
    )

    models_to_try = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"]
    last_err = None

    for m in models_to_try:
        try:
            response = client.models.generate_content(
                model=m,
                contents=hint_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    max_output_tokens=70
                )
            )
            if response and response.text:
                return {"hint": response.text.strip()}
        except Exception as e:
            last_err = e
            continue

    # Graceful fallback clue if AI quota is exhausted so the player isn't blocked
    return {
        "hint": "Check how the output data type and edge cases are handled before printing to stdout."
    }