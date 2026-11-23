import os
import re
import sys
import ast
import json
import time
import atexit
import random
import shutil
import difflib
import logging
import secrets
import tempfile
import threading
import traceback
import subprocess
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Tuple, Optional

import httpx

logger = logging.getLogger(__name__)

# Ensure .env is loaded even if runner.py is imported before main.py calls load_dotenv()
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Remote Piston-compatible endpoint (OnlineCompiler.io)
ONLINECOMPILER_PISTON_URL = "https://api.onlinecompiler.io/api/v2/piston/execute"

# Input/code size caps for /run-code and /submit-patch safety
_MAX_CODE_CHARS = 65536
_MAX_STDIN_CHARS = 32768

# Regex patterns to scrub internal container/host filesystem paths from tracebacks (Bug #5)
_WIN_PATH_RE = re.compile(r'[A-Za-z]:\\[^\n"<>]*?([^\\/\n"<>]+\.(?:py|js|go|cpp))')
_UNIX_PATH_RE = re.compile(
    r'/(?:tmp|var|piston|app|home|root|usr|opt|etc)[^\n"<>]*?/([^/\n"<>]+\.(?:py|js|go|cpp))'
)


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


def _env_float(name: str, default: float, minimum: float = 0.5) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        return default


# Stage 1 Concurrency Gate: matches OnlineCompiler's 4-concurrent limit.
_MAX_REMOTE_CONCURRENCY = _env_int("MAX_REMOTE_CONCURRENCY", default=4, minimum=1)
_SEMAPHORE_WAIT_TIMEOUT = _env_float("SANDBOX_QUEUE_TIMEOUT", default=12.0, minimum=1.0)
_MAX_429_RETRIES = 2
_REMOTE_SEMAPHORE = threading.BoundedSemaphore(_MAX_REMOTE_CONCURRENCY)

# Persistent HTTP keep-alive connection pool
_SANDBOX_HTTP = httpx.Client(
    timeout=httpx.Timeout(connect=4.0, read=9.0, write=4.0, pool=6.0),
    limits=httpx.Limits(
        max_connections=max(16, _MAX_REMOTE_CONCURRENCY * 4),
        max_keepalive_connections=max(8, _MAX_REMOTE_CONCURRENCY * 2),
        keepalive_expiry=30.0,
    ),
)
atexit.register(_SANDBOX_HTTP.close)

# Supported language configurations
LANGUAGE_MAP: Dict[str, Dict[str, str]] = {
    "python": {"language": "python", "version": "*", "ext": "py", "monaco": "python"},
    "python3": {"language": "python", "version": "*", "ext": "py", "monaco": "python"},
    "javascript": {"language": "javascript", "version": "*", "ext": "js", "monaco": "javascript"},
    "js": {"language": "javascript", "version": "*", "ext": "js", "monaco": "javascript"},
    "go": {"language": "go", "version": "*", "ext": "go", "monaco": "go"},
    "cpp": {"language": "c++", "version": "*", "ext": "cpp", "monaco": "cpp"},
}

# Defense-in-depth AST deny-list (real OS isolation is enforced by remote container + fail-closed fallback)
BANNED_MODULES = {
    "os", "subprocess", "socket", "requests", "urllib",
    "shutil", "pty", "ctypes", "importlib", "pathlib",
    "multiprocessing", "signal", "sqlite3", "http",
    "ftplib", "smtplib", "webbrowser", "pickle", "marshal",
    "runpy", "tempfile", "glob", "builtins", "inspect", "gc",
}

BANNED_CALLS = {
    "__import__", "eval", "exec", "compile", "open", "breakpoint",
}

BANNED_ATTRS = {
    "__subclasses__", "__builtins__", "__globals__",
    "__import__", "__loader__", "__spec__", "__code__", "__closure__",
    "_getframe", "_current_frames", "f_locals", "f_globals", "f_back",
    "gi_frame", "cr_frame", "ag_frame",
}

_PYTHON_STDERR_ERROR_MARKERS = (
    "Traceback (most recent call last)",
    "SyntaxError:",
    "IndentationError:",
    "TabError:",
    "NameError:",
    "TypeError:",
    "ValueError:",
    "IndexError:",
    "KeyError:",
    "ZeroDivisionError:",
    "AttributeError:",
    "RuntimeError:",
    "RecursionError:",
    "ImportError:",
    "ModuleNotFoundError:",
)

# Single-call Python batch harness with per-run cryptographic markers (blocks stdout spoofing — Bug #1B)
_PYTHON_BATCH_HARNESS = r'''
import io
import sys
import json
import time
import traceback


def _run_batch():
    orig_stdin = sys.stdin
    orig_stdout = sys.stdout
    orig_stderr = sys.stderr
    orig_dunder_stdout = getattr(sys, "__stdout__", orig_stdout)
    orig_dunder_stderr = getattr(sys, "__stderr__", orig_stderr)

    try:
        raw_payload = orig_stdin.read()
        payload = json.loads(raw_payload)
    except Exception:
        return

    start_tag = str(payload.get("start_tag", ""))
    end_tag = str(payload.get("end_tag", ""))
    user_code = payload.get("code", "")
    tests = payload.get("tests", [])

    if not start_tag or not end_tag:
        return

    def _emit(obj):
        orig_stdout.write(start_tag + json.dumps(obj) + end_tag)

    try:
        compiled = compile(user_code, "solution.py", "exec")
    except SyntaxError as exc:
        err_text = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        _emit({
            "status": "runtime_error",
            "failed_index": 0,
            "stderr": err_text[:3000],
            "runtime_ms": 1,
        })
        return

    total_ms = 0.0

    for idx, tc in enumerate(tests):
        tc_input = str(tc.get("input", ""))
        expected = str(tc.get("expected_output", "")).strip()

        out_buf = io.StringIO()
        err_buf = io.StringIO()
        in_buf = io.TextIOWrapper(io.BytesIO(tc_input.encode("utf-8")), encoding="utf-8")

        exit_code = 0
        runtime_err = None

        sys.stdin = in_buf
        sys.stdout = out_buf
        sys.stderr = err_buf
        sys.__stdout__ = out_buf
        sys.__stderr__ = err_buf
        sys.argv = ["solution.py"]

        ns = {"__name__": "__main__", "__file__": "solution.py"}

        t0 = time.perf_counter()
        try:
            exec(compiled, ns)
        except SystemExit as exc:
            if exc.code is None or exc.code == 0:
                exit_code = 0
            elif isinstance(exc.code, int):
                exit_code = exc.code
            else:
                err_buf.write(str(exc.code) + "\n")
                exit_code = 1
        except Exception as exc:
            tb = exc.__traceback__
            user_tb = tb.tb_next if (tb and tb.tb_next) else tb
            runtime_err = "".join(traceback.format_exception(type(exc), exc, user_tb)).strip()
            exit_code = 1
        finally:
            total_ms += (time.perf_counter() - t0) * 1000.0
            sys.stdin = orig_stdin
            sys.stdout = orig_stdout
            sys.stderr = orig_stderr
            sys.__stdout__ = orig_dunder_stdout
            sys.__stderr__ = orig_dunder_stderr

        actual = out_buf.getvalue().strip()
        stderr_val = err_buf.getvalue().strip()

        if exit_code != 0 or runtime_err is not None:
            detail = runtime_err or stderr_val or f"Exited with code {exit_code}"
            _emit({
                "status": "runtime_error",
                "failed_index": idx,
                "stderr": detail[:3000],
                "runtime_ms": max(1, int(round(total_ms))),
            })
            return

        if actual != expected:
            _emit({
                "status": "wrong_answer",
                "failed_index": idx,
                "actual": actual[:2000],
                "expected": expected[:2000],
                "runtime_ms": max(1, int(round(total_ms))),
            })
            return

    _emit({
        "status": "passed",
        "tests_passed": len(tests),
        "runtime_ms": max(1, int(round(total_ms))),
    })


if __name__ == "__main__":
    _run_batch()
'''

# Single-call verification harness for AI-generated problems (also uses per-run cryptographic markers)
_PYTHON_AI_VERIFY_HARNESS = r'''
import io
import sys
import json


def _exec_one(compiled, tc_input, orig_stdin, orig_stdout, orig_stderr, orig_d_out, orig_d_err):
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    in_buf = io.TextIOWrapper(io.BytesIO(tc_input.encode("utf-8")), encoding="utf-8")
    exit_code = 0
    failed = False

    sys.stdin = in_buf
    sys.stdout = out_buf
    sys.stderr = err_buf
    sys.__stdout__ = out_buf
    sys.__stderr__ = err_buf
    sys.argv = ["solution.py"]
    ns = {"__name__": "__main__", "__file__": "solution.py"}

    try:
        exec(compiled, ns)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            failed = True
            exit_code = exc.code if isinstance(exc.code, int) else 1
    except Exception:
        failed = True
        exit_code = 1
    finally:
        sys.stdin = orig_stdin
        sys.stdout = orig_stdout
        sys.stderr = orig_stderr
        sys.__stdout__ = orig_d_out
        sys.__stderr__ = orig_d_err

    return (not failed and exit_code == 0), out_buf.getvalue().strip()


def _verify():
    orig_stdin = sys.stdin
    orig_stdout = sys.stdout
    orig_stderr = sys.stderr
    orig_d_out = getattr(sys, "__stdout__", orig_stdout)
    orig_d_err = getattr(sys, "__stderr__", orig_stderr)

    try:
        payload = json.loads(orig_stdin.read())
    except Exception:
        return

    start_tag = str(payload.get("start_tag", ""))
    end_tag = str(payload.get("end_tag", ""))
    if not start_tag or not end_tag:
        return

    def _emit(obj):
        orig_stdout.write(start_tag + json.dumps(obj) + end_tag)

    buggy_code = payload.get("buggy_code", "")
    fixed_code = payload.get("fixed_code", "")
    inputs = payload.get("inputs", [])

    try:
        compiled_fixed = compile(fixed_code, "fixed.py", "exec")
        compiled_buggy = compile(buggy_code, "buggy.py", "exec")
    except SyntaxError:
        _emit({"status": "syntax_error"})
        return

    verified_tests = []
    bug_reproduced = False

    for inp in inputs:
        inp_str = str(inp)
        ok_fixed, fixed_out = _exec_one(
            compiled_fixed, inp_str, orig_stdin, orig_stdout, orig_stderr, orig_d_out, orig_d_err
        )
        if not ok_fixed or fixed_out == "":
            _emit({"status": "fixed_failed"})
            return

        verified_tests.append({"input": inp_str, "expected_output": fixed_out})

        ok_buggy, buggy_out = _exec_one(
            compiled_buggy, inp_str, orig_stdin, orig_stdout, orig_stderr, orig_d_out, orig_d_err
        )
        if (not ok_buggy) or (buggy_out != fixed_out):
            bug_reproduced = True

    _emit({
        "status": "ok" if bug_reproduced else "bug_not_reproduced",
        "tests": verified_tests,
    })


if __name__ == "__main__":
    _verify()
'''


def _is_production() -> bool:
    """Returns True when running in production (e.g., Render with ENVIRONMENT=production)."""
    return os.getenv("ENVIRONMENT", "").strip().lower() in ("production", "prod")


def _allow_local_sandbox() -> bool:
    """
    Fail-closed guard (Bug #1A): local host execution is DISABLED by default even if
    ENVIRONMENT=production is forgotten. Must explicitly set ALLOW_LOCAL_SANDBOX=true locally.
    """
    if _is_production():
        return False
    return os.getenv("ALLOW_LOCAL_SANDBOX", "").strip().lower() in ("1", "true", "yes")


def _sanitize_error_text(text: Optional[str], max_len: int = 3000) -> str:
    """Scrubs host/container filesystem paths while keeping useful Python tracebacks (Bug #5)."""
    if not text:
        return ""
    cleaned = str(text).replace("\r\n", "\n")
    cleaned = _WIN_PATH_RE.sub(r"\1", cleaned)
    cleaned = _UNIX_PATH_RE.sub(r"\1", cleaned)
    return cleaned.strip()[:max_len]


def _check_python_syntax(code_str: str) -> Optional[str]:
    """Catches Python SyntaxError/IndentationError locally before spending a remote API call."""
    try:
        compile(code_str, "solution.py", "exec")
        return None
    except SyntaxError as exc:
        raw = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        return _sanitize_error_text(raw)


def _check_python_security(code_str: str) -> Tuple[bool, str]:
    """Static AST check (defense-in-depth) to block dangerous imports, calls, and dunders."""
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
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
                    return False, f"Security Alert: Calling '{node.func.id}()' is disabled in the arcade sandbox."
            elif isinstance(node, ast.Attribute):
                if node.attr in BANNED_ATTRS:
                    return False, f"Security Alert: Accessing '{node.attr}' is disabled in the arcade sandbox."
    except SyntaxError:
        pass
    return True, ""


def _set_linux_limits() -> None:
    """Applies a 128MB RAM ceiling and 4-second CPU limit on Linux."""
    try:
        import resource
        mem_limit = 128 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem_limit, mem_limit))
        resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
    except Exception:
        pass


def _build_safe_env(tmpdir: str) -> Dict[str, str]:
    """Builds a stripped environment with ZERO secret keys for explicit local dev fallback."""
    safe_env: Dict[str, str] = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "TEMP": tmpdir,
        "TMP": tmpdir,
        "TMPDIR": tmpdir,
        "HOME": tmpdir,
    }
    if os.name == "nt":
        for key in ("SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"):
            if key in os.environ:
                safe_env[key] = os.environ[key]
    return safe_env


def _execute_remote_piston(
    code_to_run: str,
    stdin_data: str,
    lang_config: Dict[str, str],
    timeout_ms: int = 3500,
) -> Dict[str, Any]:
    """
    Executes code inside an isolated OnlineCompiler.io / Piston remote container
    using pooled keep-alive connections + _REMOTE_SEMAPHORE burst queueing.
    Logs upstream details server-side only (Bug #5).
    """
    api_key = (
        os.getenv("ONLINECOMPILER_API_KEY", "").strip()
        or os.getenv("PISTON_API_KEY", "").strip()
    )
    custom_url = os.getenv("PISTON_API_URL", "").strip()

    if custom_url:
        target_url = custom_url
    elif api_key:
        target_url = ONLINECOMPILER_PISTON_URL
    else:
        return {
            "error": True,
            "status_code": 0,
            "message": "Remote sandbox is not configured on the server.",
        }

    payload = {
        "language": lang_config["language"],
        "version": lang_config["version"],
        "files": [
            {
                "name": f"solution.{lang_config['ext']}",
                "content": code_to_run,
            }
        ],
        "stdin": stdin_data,
        "run_timeout": timeout_ms,
        "compile_timeout": 5000,
    }

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "LintIQ-Arcade-Judge/2.6",
    }
    if api_key:
        headers["Authorization"] = api_key

    for attempt in range(_MAX_429_RETRIES + 1):
        acquired = _REMOTE_SEMAPHORE.acquire(timeout=_SEMAPHORE_WAIT_TIMEOUT)
        if not acquired:
            return {
                "error": True,
                "status_code": 503,
                "message": "Sandbox queue is busy. Please wait a couple of seconds and try again.",
            }

        retry_delay: Optional[float] = None
        try:
            resp = _SANDBOX_HTTP.post(target_url, json=payload, headers=headers)
            if 200 <= resp.status_code < 300:
                return resp.json()

            if resp.status_code in (429, 502, 503, 504) and attempt < _MAX_429_RETRIES:
                retry_after_hdr = resp.headers.get("Retry-After")
                if retry_after_hdr:
                    try:
                        retry_delay = min(3.0, max(0.3, float(retry_after_hdr)))
                    except ValueError:
                        retry_delay = None
                if retry_delay is None:
                    retry_delay = (0.65 * (attempt + 1)) + random.uniform(0.05, 0.25)
            else:
                logger.warning("Remote sandbox HTTP %s: %s", resp.status_code, (resp.text or "")[:200])
                return {
                    "error": True,
                    "status_code": resp.status_code,
                    "message": "Remote sandbox is temporarily unavailable. Please try again shortly.",
                }
        except Exception as exc:
            logger.warning("Remote sandbox request failed: %s", exc)
            return {
                "error": True,
                "status_code": 0,
                "message": "Remote sandbox is temporarily unreachable. Please try again shortly.",
            }
        finally:
            _REMOTE_SEMAPHORE.release()

        if retry_delay is not None:
            time.sleep(retry_delay)

    return {
        "error": True,
        "status_code": 429,
        "message": "Sandbox is busy right now. Please wait a few seconds and try again.",
    }


def _execute_local_fallback(
    code_to_run: str,
    stdin_data: str,
    lang_key: str,
) -> Dict[str, Any]:
    """Explicit opt-in local development fallback (NEVER runs unless ALLOW_LOCAL_SANDBOX=true)."""
    if not _allow_local_sandbox():
        return {
            "error": True,
            "message": "Sandbox is temporarily unavailable. Please try again shortly.",
        }

    preexec = _set_linux_limits if sys.platform.startswith("linux") else None

    with tempfile.TemporaryDirectory(prefix="lintiq_run_") as tmpdir:
        safe_env = _build_safe_env(tmpdir)

        if lang_key in ("python", "python3"):
            sol_file = os.path.join(tmpdir, "solution.py")
            with open(sol_file, "w", encoding="utf-8") as f:
                f.write(code_to_run)
            cmd = [sys.executable, "-I", sol_file]
        elif lang_key in ("javascript", "js"):
            node_bin = shutil.which("node")
            if not node_bin:
                return {"error": True, "message": "JavaScript runtime unavailable locally."}
            sol_file = os.path.join(tmpdir, "solution.js")
            with open(sol_file, "w", encoding="utf-8") as f:
                f.write(code_to_run)
            cmd = [node_bin, sol_file]
        elif lang_key == "go":
            go_bin = shutil.which("go")
            if not go_bin:
                return {"error": True, "message": "Go runtime unavailable locally."}
            sol_file = os.path.join(tmpdir, "main.go")
            with open(sol_file, "w", encoding="utf-8") as f:
                f.write(code_to_run)
            cmd = [go_bin, "run", sol_file]
        else:
            return {"error": True, "message": "Selected language requires the remote cloud sandbox."}

        t0 = time.perf_counter()
        try:
            proc = subprocess.run(
                cmd,
                input=stdin_data,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=4,
                cwd=tmpdir,
                env=safe_env,
                preexec_fn=preexec,
            )
            elapsed_ms = int((time.perf_counter() - t0) * 1000)

            if proc.returncode == -9 or "MemoryError" in proc.stderr:
                return {
                    "run": {
                        "stdout": "",
                        "stderr": "Memory Limit Exceeded (128MB).",
                        "code": 137,
                        "signal": "SIGOM",
                        "wall_time": elapsed_ms,
                    }
                }
            return {
                "run": {
                    "stdout": proc.stdout,
                    "stderr": proc.stderr,
                    "code": proc.returncode,
                    "signal": None,
                    "wall_time": elapsed_ms,
                }
            }
        except subprocess.TimeoutExpired:
            return {
                "run": {
                    "stdout": "",
                    "stderr": "Execution timed out",
                    "code": 124,
                    "signal": "SIGKILL",
                    "status": "TO",
                    "wall_time": 4000,
                }
            }
        except Exception as exc:
            logger.warning("Local sandbox execution failed: %s", exc)
            return {"error": True, "message": "Local sandbox execution failed."}


def _dispatch_execution(
    code_to_run: str,
    stdin_data: str,
    lang_config: Dict[str, str],
    norm_lang: str,
    has_remote_config: bool,
) -> Tuple[Dict[str, Any], str]:
    """Routes execution to remote isolated sandbox; fails closed unless ALLOW_LOCAL_SANDBOX=true."""
    if has_remote_config:
        raw_res = _execute_remote_piston(code_to_run, stdin_data, lang_config)
        if raw_res.get("error"):
            if _allow_local_sandbox():
                return _execute_local_fallback(code_to_run, stdin_data, norm_lang), "local"
            status_code = raw_res.get("status_code", 0)
            if status_code in (429, 503):
                return {
                    "error": True,
                    "message": "Sandbox is busy right now. Please wait a couple of seconds and try again.",
                }, "remote"
            return {
                "error": True,
                "message": "Remote sandbox is temporarily unavailable. Please try again shortly.",
            }, "remote"
        return raw_res, "remote"

    if _allow_local_sandbox():
        return _execute_local_fallback(code_to_run, stdin_data, norm_lang), "local"

    return {
        "error": True,
        "message": "Sandbox unavailable: remote execution key is not configured on the server.",
    }, "remote"


def _check_container_errors(raw_res: Dict[str, Any], tc_label: str) -> Optional[str]:
    """Checks compile errors, timeouts, output limits, and OOM errors from a sandbox response."""
    if raw_res.get("error"):
        return str(raw_res.get("message", "Sandbox execution failed."))

    compile_info = raw_res.get("compile")
    if compile_info and compile_info.get("code", 0) != 0:
        comp_err = _sanitize_error_text(
            compile_info.get("stderr") or compile_info.get("output") or ""
        )
        return f"Compilation Error ({tc_label}):\n{comp_err}"

    run_info = raw_res.get("run", {})
    stderr_output = _sanitize_error_text(run_info.get("stderr", ""))
    exit_code = run_info.get("code", 0)
    signal = run_info.get("signal")
    run_status = run_info.get("status")

    if (
        run_status == "TO"
        or signal in ("SIGKILL", "SIGTERM", 9, 15)
        or exit_code == 124
        or "timed out" in stderr_output.lower()
    ):
        return f"Time Limit Exceeded (3.5s) ({tc_label})."

    if run_status == "OL":
        return f"Output Limit Exceeded ({tc_label}) — too much printed to stdout."

    if signal == "SIGOM" or exit_code == 137 or "Memory Limit Exceeded" in stderr_output:
        return f"Memory Limit Exceeded (128MB) ({tc_label})."

    if exit_code not in (0, None) or run_status in ("RE", "SG", "XX"):
        err_detail = stderr_output or _sanitize_error_text(run_info.get("output", ""))
        return f"Runtime Error ({tc_label}):\n{err_detail}"

    return None


def _has_remote_sandbox_config() -> bool:
    return bool(
        os.getenv("ONLINECOMPILER_API_KEY", "").strip()
        or os.getenv("PISTON_API_KEY", "").strip()
        or os.getenv("PISTON_API_URL", "").strip()
    )


# ---------------------------------------------------------------------------
# Single-Call AI Problem Verifier (1 Sandbox Call Total)
# ---------------------------------------------------------------------------

def verify_ai_problem_in_sandbox(
    buggy_code: str,
    fixed_code: str,
    inputs: List[str],
) -> Dict[str, Any]:
    """
    Verifies an AI-generated Python problem in ONE sandbox call:
    - Both scripts pass syntax & AST security checks.
    - fixed_code succeeds on every input (producing ground-truth expected_output).
    - buggy_code actually fails (wrong answer or runtime error) on at least 1 input.
    """
    if not buggy_code or not fixed_code or not inputs:
        return {"valid": False, "reason": "Missing code or test inputs."}

    for label, code in (("fixed_code", fixed_code), ("buggy_code", buggy_code)):
        syn_err = _check_python_syntax(code)
        if syn_err:
            return {"valid": False, "reason": f"{label} syntax error"}
        safe, msg = _check_python_security(code)
        if not safe:
            return {"valid": False, "reason": f"{label} blocked: {msg}"}

    nonce = secrets.token_hex(16)
    start_tag = f"__LIQ_VS_{nonce}__"
    end_tag = f"__LIQ_VE_{nonce}__"

    payload_stdin = json.dumps({
        "start_tag": start_tag,
        "end_tag": end_tag,
        "buggy_code": buggy_code,
        "fixed_code": fixed_code,
        "inputs": [str(x) for x in inputs[:4]],
    })

    raw_res, _ = _dispatch_execution(
        code_to_run=_PYTHON_AI_VERIFY_HARNESS,
        stdin_data=payload_stdin,
        lang_config=LANGUAGE_MAP["python"],
        norm_lang="python",
        has_remote_config=_has_remote_sandbox_config(),
    )

    err = _check_container_errors(raw_res, "AI Verify")
    if err:
        return {"valid": False, "reason": err}

    stdout = str(raw_res.get("run", {}).get("stdout", ""))
    s_idx = stdout.rfind(start_tag)
    e_idx = stdout.find(end_tag, s_idx + len(start_tag)) if s_idx != -1 else -1
    if s_idx == -1 or e_idx == -1:
        return {"valid": False, "reason": "Unreadable verification harness output."}

    try:
        report = json.loads(stdout[s_idx + len(start_tag):e_idx])
    except json.JSONDecodeError:
        return {"valid": False, "reason": "Invalid verification JSON."}

    if report.get("status") != "ok":
        return {"valid": False, "reason": report.get("status", "verification_failed")}

    return {"valid": True, "test_cases": report.get("tests", [])}


# ---------------------------------------------------------------------------
# Safe Test Run Sandbox (Custom stdin, Zero Streak Impact)
# ---------------------------------------------------------------------------

def run_custom_code(
    user_code: str,
    stdin_data: str = "",
    language: str = "python",
) -> Dict[str, Any]:
    """
    Executes user code with arbitrary stdin inside the cloud sandbox for debugging.
    Returns sanitized stdout + stderr without grading.
    """
    code_str = user_code or ""
    stdin_str = stdin_data or ""

    if len(code_str) > _MAX_CODE_CHARS:
        return {
            "ok": False,
            "error_type": "validation",
            "stdout": "",
            "stderr": "Code exceeds maximum size limit (64KB).",
            "runtime_ms": 0,
            "exit_code": 1,
            "execution_mode": "blocked",
        }

    if len(stdin_str) > _MAX_STDIN_CHARS:
        return {
            "ok": False,
            "error_type": "validation",
            "stdout": "",
            "stderr": "Custom input exceeds maximum size limit (32KB).",
            "runtime_ms": 0,
            "exit_code": 1,
            "execution_mode": "blocked",
        }

    norm_lang = (language or "python").lower().strip()
    lang_config = LANGUAGE_MAP.get(norm_lang, LANGUAGE_MAP["python"])

    if lang_config["language"] == "python":
        syntax_err = _check_python_syntax(code_str)
        if syntax_err:
            return {
                "ok": False,
                "error_type": "syntax_error",
                "stdout": "",
                "stderr": syntax_err,
                "runtime_ms": 0,
                "exit_code": 1,
                "execution_mode": "local_check",
            }

        is_safe, sec_msg = _check_python_security(code_str)
        if not is_safe:
            return {
                "ok": False,
                "error_type": "security",
                "stdout": "",
                "stderr": sec_msg,
                "runtime_ms": 0,
                "exit_code": 1,
                "execution_mode": "blocked",
            }

    raw_res, execution_mode = _dispatch_execution(
        code_to_run=code_str,
        stdin_data=stdin_str,
        lang_config=lang_config,
        norm_lang=norm_lang,
        has_remote_config=_has_remote_sandbox_config(),
    )

    if raw_res.get("error"):
        return {
            "ok": False,
            "error_type": "sandbox",
            "stdout": "",
            "stderr": str(raw_res.get("message", "Sandbox execution failed.")),
            "runtime_ms": 0,
            "exit_code": 1,
            "execution_mode": execution_mode,
        }

    compile_info = raw_res.get("compile")
    if compile_info and compile_info.get("code", 0) != 0:
        comp_err = _sanitize_error_text(
            compile_info.get("stderr") or compile_info.get("output") or ""
        )
        return {
            "ok": False,
            "error_type": "compile_error",
            "stdout": "",
            "stderr": comp_err,
            "runtime_ms": 0,
            "exit_code": int(compile_info.get("code", 1)),
            "execution_mode": execution_mode,
        }

    run_info = raw_res.get("run", {})
    stdout = str(run_info.get("stdout", ""))[:4000]
    stderr = _sanitize_error_text(run_info.get("stderr", ""))
    exit_code = run_info.get("code", 0)
    signal = run_info.get("signal")
    run_status = run_info.get("status")
    wall_time = run_info.get("wall_time")
    runtime_ms = max(1, int(wall_time)) if isinstance(wall_time, (int, float)) else 1

    if (
        run_status == "TO"
        or signal in ("SIGKILL", "SIGTERM", 9, 15)
        or exit_code == 124
        or "timed out" in stderr.lower()
    ):
        return {
            "ok": False,
            "error_type": "timeout",
            "stdout": stdout,
            "stderr": "Time Limit Exceeded (3.5s).",
            "runtime_ms": runtime_ms,
            "exit_code": 124,
            "execution_mode": execution_mode,
        }

    if run_status == "OL":
        return {
            "ok": False,
            "error_type": "output_limit",
            "stdout": stdout,
            "stderr": "Output Limit Exceeded — too much printed to stdout.",
            "runtime_ms": runtime_ms,
            "exit_code": 1,
            "execution_mode": execution_mode,
        }

    if signal == "SIGOM" or exit_code == 137 or "Memory Limit Exceeded" in stderr:
        return {
            "ok": False,
            "error_type": "memory_limit",
            "stdout": stdout,
            "stderr": "Memory Limit Exceeded (128MB).",
            "runtime_ms": runtime_ms,
            "exit_code": 137,
            "execution_mode": execution_mode,
        }

    stderr_has_error = bool(
        stderr and any(marker in stderr for marker in _PYTHON_STDERR_ERROR_MARKERS)
    )

    if exit_code not in (0, None) or run_status in ("RE", "SG", "XX") or stderr_has_error:
        err_detail = (
            stderr
            or _sanitize_error_text(run_info.get("output", ""))
            or f"Exited with code {exit_code}"
        )
        return {
            "ok": False,
            "error_type": "runtime_error",
            "stdout": stdout,
            "stderr": err_detail,
            "runtime_ms": runtime_ms,
            "exit_code": int(exit_code) if isinstance(exit_code, int) and exit_code != 0 else 1,
            "execution_mode": execution_mode,
        }

    return {
        "ok": True,
        "error_type": None,
        "stdout": stdout,
        "stderr": stderr,
        "runtime_ms": runtime_ms,
        "exit_code": 0,
        "execution_mode": execution_mode,
    }


# ---------------------------------------------------------------------------
# Surgical Patch Scoring (Line Diff + AST Delta)
# ---------------------------------------------------------------------------

def _normalize_lines(code: str) -> List[str]:
    lines = [line.rstrip() for line in (code or "").replace("\r\n", "\n").split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _ast_node_counter(code: str) -> Optional[Counter]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None

    counts: Counter = Counter()
    for node in ast.walk(tree):
        node_type = type(node).__name__
        if isinstance(node, ast.Name):
            sig: Tuple[Any, ...] = (node_type, node.id)
        elif isinstance(node, ast.Attribute):
            sig = (node_type, node.attr)
        elif isinstance(node, ast.Constant):
            sig = (node_type, repr(node.value))
        else:
            sig = (node_type,)
        counts[sig] += 1
    return counts


def compute_patch_metrics(
    starter_code: str,
    user_code: str,
    language: str = "python",
    runtime_ms: int = 0,
) -> Dict[str, Any]:
    starter_lines = _normalize_lines(starter_code)
    user_lines = _normalize_lines(user_code)

    raw_diff = list(difflib.unified_diff(starter_lines, user_lines, n=0))

    lines_added = 0
    lines_removed = 0
    diff_lines: List[str] = []

    for line in raw_diff:
        if line.startswith(("---", "+++", "@@")):
            continue
        if line.startswith("+"):
            lines_added += 1
            if len(diff_lines) < 20:
                diff_lines.append(line)
        elif line.startswith("-"):
            lines_removed += 1
            if len(diff_lines) < 20:
                diff_lines.append(line)

    lines_changed = max(lines_added, lines_removed)

    ast_delta: Optional[int] = None
    if (language or "python").lower().strip() in ("python", "python3"):
        starter_ast = _ast_node_counter(starter_code)
        user_ast = _ast_node_counter(user_code)
        if starter_ast is not None and user_ast is not None:
            ast_delta = (
                sum((starter_ast - user_ast).values())
                + sum((user_ast - starter_ast).values())
            )

    if lines_changed <= 2 and (ast_delta is None or ast_delta <= 6):
        grade = "Surgical"
        multiplier = 1.5
    elif lines_changed <= 5 and (ast_delta is None or ast_delta <= 14):
        grade = "Clean"
        multiplier = 1.2
    else:
        grade = "Refactor"
        multiplier = 1.0

    return {
        "lines_added": lines_added,
        "lines_removed": lines_removed,
        "lines_changed": lines_changed,
        "ast_delta": ast_delta if ast_delta is not None else 0,
        "grade": grade,
        "multiplier": multiplier,
        "runtime_ms": max(1, int(runtime_ms)),
        "diff_lines": diff_lines,
    }


# ---------------------------------------------------------------------------
# Batched Python Judge & Parallel Multi-Language Judge
# ---------------------------------------------------------------------------

def _evaluate_python_batched(
    user_code: str,
    test_cases: List[Dict[str, Any]],
    lang_config: Dict[str, str],
    norm_lang: str,
    has_remote_config: bool,
) -> Dict[str, Any]:
    """Runs ALL Python test cases in 1 sandbox call using per-run random delimiters."""
    nonce = secrets.token_hex(16)
    start_tag = f"__LIQ_BS_{nonce}__"
    end_tag = f"__LIQ_BE_{nonce}__"

    batch_stdin = json.dumps({
        "start_tag": start_tag,
        "end_tag": end_tag,
        "code": user_code,
        "tests": [
            {
                "input": str(tc.get("input", "")),
                "expected_output": str(tc.get("expected_output", "")),
            }
            for tc in test_cases
        ],
    })

    raw_res, execution_mode = _dispatch_execution(
        code_to_run=_PYTHON_BATCH_HARNESS,
        stdin_data=batch_stdin,
        lang_config=lang_config,
        norm_lang=norm_lang,
        has_remote_config=has_remote_config,
    )

    container_err = _check_container_errors(raw_res, "Batch Execution")
    if container_err:
        return {"passed": False, "message": container_err}

    run_info = raw_res.get("run", {})
    stdout = str(run_info.get("stdout", ""))

    start_idx = stdout.rfind(start_tag)
    end_idx = stdout.find(end_tag, start_idx + len(start_tag)) if start_idx != -1 else -1

    if start_idx == -1 or end_idx == -1:
        stderr_out = _sanitize_error_text(run_info.get("stderr", ""))
        return {
            "passed": False,
            "message": f"Runtime Error:\n{stderr_out or 'Execution terminated unexpectedly.'}",
        }

    try:
        report = json.loads(stdout[start_idx + len(start_tag):end_idx])
    except json.JSONDecodeError:
        return {"passed": False, "message": "Sandbox returned an unreadable test report."}

    status = report.get("status")
    failed_idx = int(report.get("failed_index", 0))

    if status == "runtime_error":
        clean_err = _sanitize_error_text(report.get("stderr", ""))
        return {
            "passed": False,
            "message": f"Runtime Error on Test Case {failed_idx + 1}:\n{clean_err}",
        }

    if status == "wrong_answer":
        tc_input = str(test_cases[failed_idx].get("input", "")) if failed_idx < len(test_cases) else ""
        return {
            "passed": False,
            "message": (
                f"Assertion Failed on Test Case {failed_idx + 1} of {len(test_cases)}\n"
                f"Input: {repr(tc_input)}\n"
                f"Expected: '{report.get('expected', '')}'\n"
                f"Received: '{report.get('actual', '')}'"
            ),
        }

    if status != "passed":
        return {"passed": False, "message": "Batch execution failed unexpectedly."}

    return {
        "passed": True,
        "message": f"All {len(test_cases)} test assertions cleared!",
        "runtime_ms": max(1, int(report.get("runtime_ms", 1))),
        "execution_mode": execution_mode,
    }


def _evaluate_non_python_parallel(
    user_code: str,
    test_cases: List[Dict[str, Any]],
    lang_config: Dict[str, str],
    norm_lang: str,
    has_remote_config: bool,
) -> Dict[str, Any]:
    """Runs non-Python test cases (JS/Go/C++) concurrently (respects global _REMOTE_SEMAPHORE)."""
    def _run_one(tc: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
        return _dispatch_execution(
            code_to_run=user_code,
            stdin_data=str(tc.get("input", "")),
            lang_config=lang_config,
            norm_lang=norm_lang,
            has_remote_config=has_remote_config,
        )

    max_workers = min(_MAX_REMOTE_CONCURRENCY, len(test_cases))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        results = list(pool.map(_run_one, test_cases))

    total_runtime_ms = 0
    execution_mode = "remote" if has_remote_config else "local"

    for idx, (raw_res, mode) in enumerate(results):
        execution_mode = mode
        container_err = _check_container_errors(raw_res, f"Test Case {idx + 1}")
        if container_err:
            return {"passed": False, "message": container_err}

        run_info = raw_res.get("run", {})
        wall_time = run_info.get("wall_time")
        if isinstance(wall_time, (int, float)):
            total_runtime_ms += int(wall_time)

        actual_output = str(run_info.get("stdout", "")).strip()
        expected_output = str(test_cases[idx].get("expected_output", "")).strip()

        if actual_output != expected_output:
            test_input = str(test_cases[idx].get("input", ""))
            return {
                "passed": False,
                "message": (
                    f"Assertion Failed on Test Case {idx + 1} of {len(test_cases)}\n"
                    f"Input: {repr(test_input)}\n"
                    f"Expected: '{expected_output}'\n"
                    f"Received: '{actual_output}'"
                ),
            }

    return {
        "passed": True,
        "message": f"All {len(test_cases)} test assertions cleared!",
        "runtime_ms": max(1, total_runtime_ms),
        "execution_mode": execution_mode,
    }


# ---------------------------------------------------------------------------
# Main Judge Entry Point
# ---------------------------------------------------------------------------

def evaluate_patch(
    user_code: str,
    test_cases: List[Dict[str, Any]],
    language: str = "python",
    starter_code: Optional[str] = None,
) -> Dict[str, Any]:
    if not test_cases:
        return {"passed": False, "message": "No test cases found for verification."}

    if len(user_code or "") > _MAX_CODE_CHARS:
        return {"passed": False, "message": "Code exceeds maximum size limit (64KB)."}

    norm_lang = (language or "python").lower().strip()
    lang_config = LANGUAGE_MAP.get(norm_lang, LANGUAGE_MAP["python"])

    if lang_config["language"] == "python":
        syntax_err = _check_python_syntax(user_code)
        if syntax_err:
            return {"passed": False, "message": f"Syntax Error:\n{syntax_err}"}

        is_safe, sec_msg = _check_python_security(user_code)
        if not is_safe:
            return {"passed": False, "message": sec_msg}

    has_remote_config = _has_remote_sandbox_config()

    if lang_config["language"] == "python":
        result = _evaluate_python_batched(
            user_code=user_code,
            test_cases=test_cases,
            lang_config=lang_config,
            norm_lang=norm_lang,
            has_remote_config=has_remote_config,
        )
    else:
        result = _evaluate_non_python_parallel(
            user_code=user_code,
            test_cases=test_cases,
            lang_config=lang_config,
            norm_lang=norm_lang,
            has_remote_config=has_remote_config,
        )

    if result.get("passed") and starter_code is not None:
        result["patch_metrics"] = compute_patch_metrics(
            starter_code=starter_code,
            user_code=user_code,
            language=lang_config["language"],
            runtime_ms=int(result.get("runtime_ms", 1)),
        )

    return result