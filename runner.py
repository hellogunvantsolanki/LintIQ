import os
import sys
import ast
import json
import shutil
import tempfile
import subprocess
import urllib.request
import urllib.error
from typing import List, Dict, Any, Tuple

# Remote Piston-compatible endpoints
ONLINECOMPILER_PISTON_URL = "https://api.onlinecompiler.io/api/v2/piston/execute"
EMKC_PISTON_URL = "https://emkc.org/api/v2/piston/execute"

# Supported language configurations
LANGUAGE_MAP: Dict[str, Dict[str, str]] = {
    "python": {"language": "python", "version": "3.10.0", "ext": "py", "monaco": "python"},
    "python3": {"language": "python", "version": "3.10.0", "ext": "py", "monaco": "python"},
    "javascript": {"language": "javascript", "version": "18.15.0", "ext": "js", "monaco": "javascript"},
    "js": {"language": "javascript", "version": "18.15.0", "ext": "js", "monaco": "javascript"},
    "go": {"language": "go", "version": "1.16.2", "ext": "go", "monaco": "go"},
    "cpp": {"language": "c++", "version": "10.2.0", "ext": "cpp", "monaco": "cpp"},
}

# Blocked Python modules for local fallback execution
BANNED_MODULES = {
    "os", "subprocess", "socket", "requests", "urllib",
    "shutil", "pty", "ctypes", "importlib", "pathlib", "multiprocessing"
}


def _check_python_security(code_str: str) -> Tuple[bool, str]:
    """Static AST check to block dangerous system imports in Python submissions."""
    try:
        tree = ast.parse(code_str)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root_pkg = alias.name.split(".")[0]
                    if root_pkg in BANNED_MODULES:
                        return False, f"Security Alert: Importing '{root_pkg}' is disabled in the arcade sandbox."
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root_pkg = node.module.split(".")[0]
                    if root_pkg in BANNED_MODULES:
                        return False, f"Security Alert: Importing from '{root_pkg}' is disabled in the arcade sandbox."
    except SyntaxError:
        # Let the compiler/interpreter report the exact syntax error line
        pass
    return True, ""


def _set_linux_limits() -> None:
    """Applies a 128MB RAM ceiling and 4-second CPU limit on Linux (Render)."""
    try:
        import resource
        mem_limit = 128 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem_limit, mem_limit))
        resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
    except Exception:
        pass


def _execute_remote_piston(
    user_code: str,
    test_input: str,
    lang_config: Dict[str, str],
    timeout_ms: int = 3500
) -> Dict[str, Any]:
    """Executes code on a Piston-compatible remote container cluster."""
    api_key = os.getenv("ONLINECOMPILER_API_KEY", "").strip() or os.getenv("PISTON_API_KEY", "").strip()
    custom_url = os.getenv("PISTON_API_URL", "").strip()

    if custom_url:
        target_url = custom_url
    elif api_key:
        target_url = ONLINECOMPILER_PISTON_URL
    else:
        target_url = EMKC_PISTON_URL

    payload = {
        "language": lang_config["language"],
        "version": "*" if "onlinecompiler.io" in target_url else lang_config["version"],
        "files": [
            {
                "name": f"solution.{lang_config['ext']}",
                "content": user_code
            }
        ],
        "stdin": test_input,
        "run_timeout": timeout_ms,
        "compile_timeout": 5000
    }

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "LintIQ-Arcade-Judge/1.4"
    }
    if api_key:
        headers["Authorization"] = api_key

    req = urllib.request.Request(
        target_url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=6) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as http_err:
        return {
            "error": True,
            "status_code": http_err.code,
            "message": f"Remote Judge HTTP {http_err.code}: {http_err.reason}"
        }
    except Exception as exc:
        return {
            "error": True,
            "status_code": 0,
            "message": f"Remote Judge Unreachable: {str(exc)}"
        }


def _execute_local_fallback(
    user_code: str,
    test_input: str,
    lang_key: str
) -> Dict[str, Any]:
    """Executes Python or Node.js locally inside a memory-capped subprocess."""
    preexec = _set_linux_limits if sys.platform.startswith("linux") else None

    if lang_key in ("python", "python3"):
        cmd = [sys.executable, "-c", user_code]
    elif lang_key in ("javascript", "js"):
        node_bin = shutil.which("node")
        if not node_bin:
            return {
                "error": True,
                "message": "Node.js runtime not found locally. Set ONLINECOMPILER_API_KEY in .env for cloud JS execution."
            }
        cmd = [node_bin, "-e", user_code]
    elif lang_key == "go":
        go_bin = shutil.which("go")
        if not go_bin:
            return {
                "error": True,
                "message": "Go toolchain not installed on this host. Set ONLINECOMPILER_API_KEY in .env for cloud Go execution."
            }
        with tempfile.TemporaryDirectory() as tmpdir:
            go_file = os.path.join(tmpdir, "main.go")
            with open(go_file, "w", encoding="utf-8") as f:
                f.write(user_code)
            try:
                proc = subprocess.run(
                    [go_bin, "run", go_file],
                    input=test_input,
                    text=True,
                    capture_output=True,
                    timeout=4,
                    preexec_fn=preexec
                )
                return {
                    "run": {
                        "stdout": proc.stdout,
                        "stderr": proc.stderr,
                        "code": proc.returncode,
                        "signal": None
                    }
                }
            except subprocess.TimeoutExpired:
                return {"run": {"stdout": "", "stderr": "timed out", "code": 124, "signal": "SIGKILL"}}
    else:
        return {
            "error": True,
            "message": f"Language '{lang_key}' requires ONLINECOMPILER_API_KEY in .env."
        }

    try:
        proc = subprocess.run(
            cmd,
            input=test_input,
            text=True,
            capture_output=True,
            timeout=4,
            preexec_fn=preexec
        )
        if proc.returncode == -9 or "MemoryError" in proc.stderr:
            return {
                "run": {
                    "stdout": "",
                    "stderr": "Memory Limit Exceeded (128MB).",
                    "code": 137,
                    "signal": "SIGOM"
                }
            }
        return {
            "run": {
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "code": proc.returncode,
                "signal": None
            }
        }
    except subprocess.TimeoutExpired:
        return {
            "run": {
                "stdout": "",
                "stderr": "Execution timed out",
                "code": 124,
                "signal": "SIGKILL"
            }
        }
    except Exception as exc:
        return {"error": True, "message": f"Local Sandbox Error: {str(exc)}"}


def evaluate_patch(
    user_code: str,
    test_cases: List[Dict[str, Any]],
    language: str = "python"
) -> Dict[str, Any]:
    if not test_cases:
        return {"passed": False, "message": "No test cases found for verification."}

    norm_lang = (language or "python").lower().strip()
    lang_config = LANGUAGE_MAP.get(norm_lang, LANGUAGE_MAP["python"])

    # Run static AST check for Python submissions
    if lang_config["language"] == "python":
        is_safe, sec_msg = _check_python_security(user_code)
        if not is_safe:
            return {"passed": False, "message": sec_msg}

    has_remote_config = bool(
        os.getenv("ONLINECOMPILER_API_KEY")
        or os.getenv("PISTON_API_KEY")
        or os.getenv("PISTON_API_URL")
    )

    for idx, tc in enumerate(test_cases):
        test_input = str(tc.get("input", ""))
        expected_output = str(tc.get("expected_output", "")).strip()

        # Prefer remote container sandbox if configured or if non-Python language is requested
        if has_remote_config or lang_config["language"] != "python":
            raw_res = _execute_remote_piston(user_code, test_input, lang_config)
            # Automatic fallback to local sandbox if remote returns 401/unreachable
            if raw_res.get("error"):
                raw_res = _execute_local_fallback(user_code, test_input, norm_lang)
        else:
            raw_res = _execute_local_fallback(user_code, test_input, norm_lang)

        if raw_res.get("error"):
            return {"passed": False, "message": raw_res["message"]}

        # Check compile errors (if returned separately)
        compile_info = raw_res.get("compile")
        if compile_info and compile_info.get("code", 0) != 0:
            comp_err = compile_info.get("stderr", "").strip() or compile_info.get("output", "").strip()
            return {
                "passed": False,
                "message": f"Compilation Error on Test Case {idx + 1}:\n{comp_err}"
            }

        run_info = raw_res.get("run", {})
        actual_output = str(run_info.get("stdout", "")).strip()
        stderr_output = str(run_info.get("stderr", "")).strip()
        exit_code = run_info.get("code", 0)
        signal = run_info.get("signal")

        # Timeout detection (SIGKILL / SIGTERM / exit code 124)
        if signal in ("SIGKILL", "SIGTERM", 9, 15) or exit_code == 124 or "timed out" in stderr_output.lower():
            return {
                "passed": False,
                "message": f"Time Limit Exceeded (3.5s) on Test Case {idx + 1}."
            }

        # Memory limit detection
        if signal == "SIGOM" or exit_code == 137 or "Memory Limit Exceeded" in stderr_output:
            return {
                "passed": False,
                "message": f"Memory Limit Exceeded (128MB) on Test Case {idx + 1}."
            }

        # Runtime or compilation error detection
        if exit_code not in (0, None):
            err_detail = stderr_output if stderr_output else str(run_info.get("output", "")).strip()
            return {
                "passed": False,
                "message": f"Runtime Error on Test Case {idx + 1}:\n{err_detail}"
            }

        # Output comparison
        if actual_output != expected_output:
            return {
                "passed": False,
                "message": (
                    f"Assertion Failed on Test Case {idx + 1} of {len(test_cases)}\n"
                    f"Input: {repr(test_input)}\n"
                    f"Expected: '{expected_output}'\n"
                    f"Received: '{actual_output}'"
                )
            }

    return {
        "passed": True,
        "message": f"All {len(test_cases)} test assertions cleared!"
    }