import asyncio
import atexit
import json
import logging
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

import httpx
from ai_generator import _call_gemini_api as _DEFAULT_CALL_GEMINI_API, _load_env_key
from database import (
    ensure_language_variants_db,
    fetch_sqlite_problem_translation,
    fetch_supabase_problem_translation,
    normalize_mode,
    save_sqlite_problem_translation,
    save_supabase_problem_translation,
)
from runner import _resolve_language_config, normalize_language_key, strip_language_comments

# Keep module-level _call_gemini_api hook so tests can monkeypatch translator._call_gemini_api
_call_gemini_api = _DEFAULT_CALL_GEMINI_API

# Fast non-preview Flash-Lite / Flash models first; slow preview model demoted to final fallback
TRANSLATION_MODELS: Tuple[str, ...] = (
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
)

TRANSLATION_TIMEOUT_SEC = 15.0
_TRANSLATION_HTTP = httpx.Client(
    timeout=httpx.Timeout(connect=4.0, read=TRANSLATION_TIMEOUT_SEC, write=4.0, pool=5.0),
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=30.0),
)
atexit.register(_TRANSLATION_HTTP.close)

# Ensure SQLite translation cache runs in WAL mode with busy_timeout=10000
try:
    ensure_language_variants_db()
except Exception:
    pass

logger = logging.getLogger(__name__)

# Tier 1: Permanent in-process translation cache keyed by (mode, problem_id, canonical_lang)
_MEM_CACHE_LOCK = threading.Lock()
_MEM_TRANSLATION_CACHE: Dict[Tuple[str, int, str], str] = {}

# Deduplication locks so concurrent requests for the same key only trigger one LLM translation
_SYNC_KEY_LOCKS_GUARD = threading.Lock()
_SYNC_KEY_LOCKS: Dict[Tuple[str, int, str], threading.Lock] = {}

_ASYNC_KEY_LOCKS_GUARD = threading.Lock()
_ASYNC_KEY_LOCKS: Dict[Tuple[Any, str, int, str], asyncio.Lock] = {}

_LANGUAGE_GUIDANCE: Dict[str, Tuple[str, str]] = {
    "java": (
        "Java 21",
        "Produce ONE single self-contained file with `public class Solution` and `public static void main(String[] args)`. "
        "Import only needed standard classes (`java.util.*`, `java.io.*`). Never place a package declaration.",
    ),
    "cpp": (
        "C++20",
        "Produce ONE single self-contained C++20 file with `int main()`, standard headers (`<iostream>`, `<vector>`, "
        "`<string>`, etc. as needed), reading stdin via `std::cin` / `std::getline` and writing exact stdout via `std::cout`.",
    ),
    "javascript": (
        "JavaScript (Node.js 24)",
        "Produce ONE single runnable Node.js file reading stdin via `const fs = require('fs'); fs.readFileSync(0, 'utf8')` "
        "(or `readline`/splitting lines) and writing exact stdout via `console.log` / `process.stdout.write`.",
    ),
    "typescript": (
        "TypeScript (Node.js native strip-types compatible)",
        "Produce ONE single runnable TypeScript file with clean explicit types (e.g. `number`, `string`, `boolean`, `number[]`). "
        "Use `import * as fs from 'fs';` with `fs.readFileSync(0, 'utf8')`. Avoid TypeScript `enum`, `namespace`, or parameter properties "
        "so Node `--experimental-strip-types` executes it directly cleanly.",
    ),
    "go": (
        "Go 1.22",
        "Produce ONE single runnable Go file starting with `package main` and defining `func main()`. "
        "Only import packages actually used (e.g. `fmt`, `os`, `bufio`, `strings`, `strconv`) so `go build` never fails on unused imports.",
    ),
}

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_+-]*\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _get_sync_key_lock(cache_key: Tuple[str, int, str]) -> threading.Lock:
    with _SYNC_KEY_LOCKS_GUARD:
        lock = _SYNC_KEY_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _SYNC_KEY_LOCKS[cache_key] = lock
        return lock


def _get_async_key_lock(cache_key: Tuple[str, int, str]) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    full_key = (id(loop), cache_key[0], cache_key[1], cache_key[2])
    with _ASYNC_KEY_LOCKS_GUARD:
        lock = _ASYNC_KEY_LOCKS.get(full_key)
        if lock is None:
            lock = asyncio.Lock()
            _ASYNC_KEY_LOCKS[full_key] = lock
        return lock


def _clean_translated_code(raw_code: str, canonical_lang: str) -> str:
    text = str(raw_code or "").replace("\r\n", "\n").strip()
    m = _FENCE_RE.match(text)
    if m:
        text = m.group(1).strip()
    cleaned = strip_language_comments(text, canonical_lang).strip()
    return (cleaned + "\n") if cleaned else ""


def _validate_translated_structure(code: str, canonical_lang: str) -> None:
    if not code or not code.strip():
        raise RuntimeError(f"Empty translation returned for {canonical_lang}.")
    if canonical_lang == "java" and "class Solution" not in code:
        raise RuntimeError("Translated Java code is missing `class Solution`.")
    if canonical_lang == "cpp" and "main(" not in code:
        raise RuntimeError("Translated C++ code is missing `main()`.")
    if canonical_lang == "go" and ("package main" not in code or "func main(" not in code):
        raise RuntimeError("Translated Go code must contain `package main` and `func main()`.")


def _build_translation_prompt(
    target_lang: str,
    python_buggy_code: str,
    title: str = "",
    description: str = "",
    test_cases: Optional[List[Dict[str, Any]]] = None,
) -> str:
    display_name, lang_rules = _LANGUAGE_GUIDANCE.get(
        target_lang, (target_lang.title(), "Produce a single runnable source file matching stdin/stdout.")
    )
    sample_io_block = ""
    if test_cases and isinstance(test_cases, list):
        first = test_cases[0] if isinstance(test_cases[0], dict) else {}
        if first:
            sample_io_block = (
                f"\nSample stdin:\n{first.get('input', '')!r}\n"
                f"Sample stdout produced by fixed program:\n{first.get('expected_output', '')!r}\n"
            )

    return (
        f"You are translating a debugging challenge starter file from Python 3 into {display_name}.\n\n"
        f"Challenge title: {title or 'Debugging Challenge'}\n"
        f"Problem description:\n{description or 'Translate stdin/stdout behavior identically.'}\n"
        f"{sample_io_block}\n"
        "STRICT RULES:\n"
        "1. Translate the Python starter code below faithfully into idiomatic target-language code with IDENTICAL stdin parsing, "
        "identical data structures/logic, and identical stdout formatting.\n"
        "2. PRESERVE THE EXACT LOGICAL BUG(S) present in the Python starter code. Do NOT fix the bug!\n"
        "3. The bug must remain fixable as a minimal surgical patch (1 to 3 edited lines) in the translated code.\n"
        "4. Include ZERO comments (no //, no /* */, no #), ZERO markdown explanations, and NO helper hint variable names.\n"
        f"5. Target language structure rule: {lang_rules}\n"
        '6. Respond ONLY with a valid JSON object of the exact form: {"code": "<complete source file>"}\n\n'
        f"Python buggy starter code to translate:\n```python\n{python_buggy_code}\n```"
    )


def _store_cached_translation(mode: str, problem_id: int, canonical_lang: str, code: str) -> None:
    key = (mode, int(problem_id), canonical_lang)
    with _MEM_CACHE_LOCK:
        _MEM_TRANSLATION_CACHE[key] = code
    save_sqlite_problem_translation(mode, int(problem_id), canonical_lang, code)
    save_supabase_problem_translation(mode, int(problem_id), canonical_lang, code)


def get_cached_translation(mode: str, problem_id: int, language: str) -> Optional[str]:
    """Checks 3-tier permanent cache: memory -> Supabase Postgres -> local SQLite."""
    norm_mode = normalize_mode(mode)
    canonical_lang = normalize_language_key(language)
    if canonical_lang == "python":
        return None
    key = (norm_mode, int(problem_id), canonical_lang)

    with _MEM_CACHE_LOCK:
        cached = _MEM_TRANSLATION_CACHE.get(key)
        if cached:
            return cached

    supa_code = fetch_supabase_problem_translation(norm_mode, int(problem_id), canonical_lang)
    if supa_code:
        cleaned = _clean_translated_code(supa_code, canonical_lang)
        if cleaned:
            with _MEM_CACHE_LOCK:
                _MEM_TRANSLATION_CACHE[key] = cleaned
            save_sqlite_problem_translation(norm_mode, int(problem_id), canonical_lang, cleaned)
            return cleaned

    sqlite_code = fetch_sqlite_problem_translation(norm_mode, int(problem_id), canonical_lang)
    if sqlite_code:
        cleaned = _clean_translated_code(sqlite_code, canonical_lang)
        if cleaned:
            with _MEM_CACHE_LOCK:
                _MEM_TRANSLATION_CACHE[key] = cleaned
            save_supabase_problem_translation(norm_mode, int(problem_id), canonical_lang, cleaned)
            return cleaned

    return None


def _extract_gemini_http_error(resp: httpx.Response) -> str:
    status_code = resp.status_code
    err_status = ""
    err_msg = ""
    try:
        body = resp.json()
        err_obj = body.get("error") if isinstance(body, dict) else None
        if isinstance(err_obj, dict):
            err_status = str(err_obj.get("status") or "").strip()
            err_msg = str(err_obj.get("message") or "").strip()
    except Exception:
        pass
    if not err_msg:
        err_msg = (resp.text or "").strip().replace("\n", " ")[:200]
    label = f"{status_code} {err_status}".strip()
    return f"{label}: {err_msg}" if err_msg else str(label or f"HTTP {status_code}")


def _call_translation_gemini_api(
    api_key: str,
    prompt: str,
    temperature: float = 0.15,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Calls Gemini models in priority order with a 15s read timeout per model and
    returns `(parsed_json, error_summary)` so real API errors (e.g. 429 RESOURCE_EXHAUSTED,
    ReadTimeout) propagate clearly when all models fail.
    """
    errors: List[str] = []

    for model_name in TRANSLATION_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        gen_config: Dict[str, Any] = {
            "temperature": temperature,
            "responseMimeType": "application/json",
        }
        if model_name.startswith("gemini-2.5"):
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": gen_config,
        }

        try:
            resp = _TRANSLATION_HTTP.post(
                url,
                json=payload,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "x-goog-api-key": api_key,
                },
            )
            if resp.status_code != 200:
                detail = _extract_gemini_http_error(resp)
                logger.warning("Gemini translation %s HTTP %s", model_name, detail[:220])
                errors.append(f"{model_name} -> {detail}")
                continue

            raw_data = resp.json()
            candidates = raw_data.get("candidates") or []
            if not candidates:
                detail = f"empty candidates ({str(raw_data)[:160]})"
                logger.warning("Gemini translation %s: %s", model_name, detail)
                errors.append(f"{model_name} -> {detail}")
                continue

            parts = candidates[0].get("content", {}).get("parts") or []
            text_content = "".join(
                part["text"] for part in parts if "text" in part and not part.get("thought")
            ).strip()

            cleaned_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_content, flags=re.IGNORECASE).strip()
            match = re.search(r"\{[\s\S]*\}", cleaned_text)
            if not match:
                detail = f"non-JSON response ({cleaned_text[:160]})"
                logger.warning("Gemini translation %s: %s", model_name, detail)
                errors.append(f"{model_name} -> {detail}")
                continue

            return json.loads(match.group(0), strict=False), None
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            logger.warning("Gemini translation %s failed (%s)", model_name, detail[:200])
            errors.append(f"{model_name} -> {detail}")

    if not errors:
        return None, "no translation models attempted"

    # Prefer surfacing quota/429 errors if any model hit rate/daily quota
    quota_errors = [e for e in errors if "429" in e or "resource_exhausted" in e.lower() or "quota" in e.lower()]
    return None, (quota_errors[0] if quota_errors else errors[-1])


def _translate_via_gemini(
    canonical_lang: str,
    python_buggy_code: str,
    title: str = "",
    description: str = "",
    test_cases: Optional[List[Dict[str, Any]]] = None,
) -> str:
    api_key = _load_env_key()
    if not api_key:
        raise RuntimeError(
            f"Translation to {canonical_lang} requires GEMINI_API_KEY / GOOGLE_API_KEY when not cached yet."
        )
    prompt = _build_translation_prompt(
        target_lang=canonical_lang,
        python_buggy_code=python_buggy_code,
        title=title,
        description=description,
        test_cases=test_cases,
    )

    api_error: Optional[str] = None
    if _call_gemini_api is not _DEFAULT_CALL_GEMINI_API:
        parsed = _call_gemini_api(api_key, prompt, temperature=0.15)
    else:
        parsed, api_error = _call_translation_gemini_api(api_key, prompt, temperature=0.15)

    if not isinstance(parsed, dict):
        reason = api_error or f"Gemini returned no translation payload for {canonical_lang}."
        raise RuntimeError(f"Gemini translation failed for {canonical_lang}: {reason}")

    raw_code = parsed.get("code") or parsed.get("buggy_code") or ""
    cleaned = _clean_translated_code(raw_code, canonical_lang)
    _validate_translated_structure(cleaned, canonical_lang)
    return cleaned


def get_or_translate_problem_code(
    mode: str,
    problem_id: int,
    language: str,
    python_buggy_code: str,
    title: str = "",
    description: str = "",
    test_cases: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """
    Returns clean Python starter code when language='python', or resolves/translates & permanently
    caches the requested language variant using the 3-tier permanent cache.
    """
    canonical_lang, _ = _resolve_language_config(language)
    if canonical_lang == "python":
        return strip_language_comments(python_buggy_code or "", "python")

    norm_mode = normalize_mode(mode)
    cached = get_cached_translation(norm_mode, int(problem_id), canonical_lang)
    if cached:
        return cached

    if not isinstance(python_buggy_code, str) or not python_buggy_code.strip():
        raise ValueError("Source Python starter code is empty and cannot be translated.")

    key_lock = _get_sync_key_lock((norm_mode, int(problem_id), canonical_lang))
    with key_lock:
        cached = get_cached_translation(norm_mode, int(problem_id), canonical_lang)
        if cached:
            return cached

        translated = _translate_via_gemini(
            canonical_lang=canonical_lang,
            python_buggy_code=python_buggy_code,
            title=title,
            description=description,
            test_cases=test_cases,
        )
        _store_cached_translation(norm_mode, int(problem_id), canonical_lang, translated)
        return translated


async def get_or_translate_problem_code_async(
    mode: str,
    problem_id: int,
    language: str,
    python_buggy_code: str,
    title: str = "",
    description: str = "",
    test_cases: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Async single-flight wrapper using per-key asyncio.Lock + thread offload for cache/Gemini calls."""
    canonical_lang, _ = _resolve_language_config(language)
    if canonical_lang == "python":
        return strip_language_comments(python_buggy_code or "", "python")

    norm_mode = normalize_mode(mode)
    async_lock = _get_async_key_lock((norm_mode, int(problem_id), canonical_lang))
    async with async_lock:
        return await asyncio.to_thread(
            get_or_translate_problem_code,
            norm_mode,
            int(problem_id),
            canonical_lang,
            python_buggy_code,
            title,
            description,
            test_cases,
        )
