"""
Resumable background cache pre-warmer for LintIQ multi-language starter translations.

Reads problems strictly read-only from `interview_problems.db` and `problems.db`,
skips pairs already persisted in `language_variants.db`, translates remaining items
via `translator.get_or_translate_problem_code_async` with bounded concurrency +
exponential backoff, and stores failed pairs cleanly in `backend/prewarm_failed.jsonl`.
"""

import argparse
import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Anchor relative SQLite / .env paths inside backend/ regardless of invocation CWD
os.chdir(BACKEND_DIR)

from database import (  # noqa: E402
    ensure_language_variants_db,
    fetch_sqlite_cached_translation_keys,
    get_catalog_connection,
    normalize_mode,
)
from runner import _resolve_language_config  # noqa: E402
from translator import get_or_translate_problem_code_async  # noqa: E402

DEFAULT_LANGS = ("java", "cpp", "javascript", "typescript", "go")
FAILED_JSONL_PATH = BACKEND_DIR / "prewarm_failed.jsonl"
LOG_FILE_PATH = BACKEND_DIR / "prewarm.log"
RETRY_BACKOFFS_SEC = (2.0, 4.0, 8.0, 16.0, 32.0)
MAX_CONSECUTIVE_FAILURES = 15


def _format_eta(seconds: Optional[float]) -> str:
    if seconds is None or seconds < 0 or seconds == float("inf"):
        return "--"
    secs = int(round(seconds))
    if secs < 60:
        return f"{secs}s"
    mins, rem_s = divmod(secs, 60)
    if mins < 60:
        return f"{mins}m" if rem_s < 15 else f"{mins}m{rem_s:02d}s"
    hours, rem_m = divmod(mins, 60)
    return f"{hours}h{rem_m:02d}m"


def _emit_line(line: str, log_fp) -> None:
    print(line, flush=True)
    if log_fp is not None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_fp.write(f"[{stamp}] {line}\n")
        log_fp.flush()


def _parse_modes(raw_mode: str) -> List[str]:
    norm = (raw_mode or "all").strip().lower()
    if norm == "all":
        return ["interview", "practice"]
    if norm in ("interview", "practice"):
        return [norm]
    raise ValueError(f"Unsupported --mode '{raw_mode}'. Choose interview, practice, or all.")


def _parse_langs(raw_langs: str) -> List[str]:
    out: List[str] = []
    seen = set()
    for part in (raw_langs or "").split(","):
        candidate = part.strip()
        if not candidate:
            continue
        canonical, _ = _resolve_language_config(candidate)
        if canonical == "python":
            continue
        if canonical not in seen:
            seen.add(canonical)
            out.append(canonical)
    if not out:
        raise ValueError("No valid non-Python target languages supplied in --langs.")
    return out


def _load_catalog_problems(modes: List[str]) -> Dict[Tuple[str, int], Dict[str, Any]]:
    problems_by_key: Dict[Tuple[str, int], Dict[str, Any]] = {}
    for mode in modes:
        conn = get_catalog_connection(mode)
        try:
            rows = conn.execute(
                """
                SELECT id, title, description, buggy_code, test_cases
                FROM problems
                ORDER BY id ASC
                """
            ).fetchall()
            for pid, title, description, buggy_code, raw_tests in rows:
                if not isinstance(buggy_code, str) or not buggy_code.strip():
                    continue
                try:
                    parsed_tests = json.loads(raw_tests) if isinstance(raw_tests, str) else (raw_tests or [])
                except Exception:
                    parsed_tests = []
                problems_by_key[(mode, int(pid))] = {
                    "mode": mode,
                    "problem_id": int(pid),
                    "title": title or f"Problem #{pid}",
                    "description": description or "",
                    "buggy_code": buggy_code,
                    "test_cases": parsed_tests if isinstance(parsed_tests, list) else [],
                }
        finally:
            conn.close()
    return problems_by_key


def _read_failed_entries() -> List[Tuple[str, int, str]]:
    if not FAILED_JSONL_PATH.exists():
        return []
    seen = set()
    entries: List[Tuple[str, int, str]] = []
    for raw_line in FAILED_JSONL_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            m = normalize_mode(rec.get("mode"))
            pid = int(rec["problem_id"])
            lang, _ = _resolve_language_config(rec.get("language"))
            if lang == "python":
                continue
            key = (m, pid, lang)
            if key not in seen:
                seen.add(key)
                entries.append(key)
        except Exception:
            continue
    return entries


def _is_retryable_error(exc: Exception) -> bool:
    msg = f"{type(exc).__name__}: {exc}".lower()
    markers = (
        "429",
        "rate",
        "quota",
        "resource exhausted",
        "timeout",
        "timed out",
        "temporarily",
        "connection",
        "remoteprotocol",
        "empty translation",
        "empty candidates",
        "502",
        "503",
        "504",
    )
    return any(marker in msg for marker in markers) or isinstance(exc, (TimeoutError, ConnectionError, OSError))


async def _translate_with_backoff(
    item: Dict[str, Any],
    language: str,
    stop_event: asyncio.Event,
) -> None:
    last_exc: Optional[Exception] = None
    max_attempts = len(RETRY_BACKOFFS_SEC)
    for attempt in range(1, max_attempts + 1):
        if stop_event.is_set():
            raise asyncio.CancelledError()
        try:
            await get_or_translate_problem_code_async(
                mode=item["mode"],
                problem_id=item["problem_id"],
                language=language,
                python_buggy_code=item["buggy_code"],
                title=item["title"],
                description=item["description"],
                test_cases=item["test_cases"],
            )
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            last_exc = exc
            if attempt >= max_attempts or not _is_retryable_error(exc):
                raise
            wait_sec = RETRY_BACKOFFS_SEC[attempt - 1]
            await asyncio.sleep(wait_sec)
    if last_exc is not None:
        raise last_exc


async def run_prewarm(args: argparse.Namespace) -> int:
    ensure_language_variants_db()
    modes = _parse_modes(args.mode)
    langs = _parse_langs(args.langs)
    concurrency = max(1, int(args.concurrency))
    delay = max(0.0, float(args.delay))
    limit = int(args.limit) if args.limit is not None else None
    if limit is not None and limit <= 0:
        raise ValueError("--limit must be a positive integer.")

    catalog = _load_catalog_problems(modes)
    cached_keys = fetch_sqlite_cached_translation_keys()

    tasks_meta: List[Tuple[Dict[str, Any], str]] = []
    cached_in_scope = 0

    if args.retry_failed:
        mode_set = set(modes)
        lang_set = set(langs)
        for m, pid, lang in _read_failed_entries():
            if m not in mode_set or lang not in lang_set:
                continue
            item = catalog.get((m, pid))
            if not item:
                continue
            if (m, pid, lang) in cached_keys:
                cached_in_scope += 1
                continue
            tasks_meta.append((item, lang))
    else:
        for mode in modes:
            mode_items = [catalog[k] for k in sorted(catalog.keys()) if k[0] == mode]
            for item in mode_items:
                for lang in langs:
                    key = (mode, item["problem_id"], lang)
                    if key in cached_keys:
                        cached_in_scope += 1
                    else:
                        tasks_meta.append((item, lang))

    total_remaining = len(tasks_meta)
    if limit is not None:
        tasks_meta = tasks_meta[:limit]

    total_to_run = len(tasks_meta)
    run_label = "retry-failed " if args.retry_failed else ""
    with LOG_FILE_PATH.open("a", encoding="utf-8") as log_fp:
        _emit_line(
            f"Found {cached_in_scope} already cached | {total_remaining} remaining to translate"
            + (f" (processing up to {total_to_run} for this --limit {limit} {run_label}run)" if limit else ""),
            log_fp,
        )
        if total_to_run == 0:
            _emit_line("Nothing to translate — cache is already warm.", log_fp)
            return 0

        sem = asyncio.Semaphore(concurrency)
        stop_event = asyncio.Event()
        state_lock = asyncio.Lock()
        started_at = time.monotonic()
        completed = 0
        succeeded = 0
        failed_count = 0
        consecutive_failures = 0
        circuit_tripped = False
        failed_records: List[Dict[str, Any]] = []
        worker_tasks: List[asyncio.Task[None]] = []

        async def worker(item: Dict[str, Any], lang: str) -> None:
            nonlocal completed, succeeded, failed_count, consecutive_failures, circuit_tripped
            if stop_event.is_set():
                return
            async with sem:
                if stop_event.is_set():
                    return
                ok = False
                err_msg = ""
                try:
                    await _translate_with_backoff(item, lang, stop_event)
                    ok = True
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    err_msg = f"{type(exc).__name__}: {str(exc)[:220]}"
                finally:
                    if delay > 0 and not stop_event.is_set():
                        await asyncio.sleep(delay)

                async with state_lock:
                    if stop_event.is_set() and not ok:
                        return
                    completed += 1
                    if ok:
                        succeeded += 1
                        consecutive_failures = 0
                        status_word = "cached"
                    else:
                        failed_count += 1
                        consecutive_failures += 1
                        status_word = "FAILED"
                        rec = {
                            "mode": item["mode"],
                            "problem_id": item["problem_id"],
                            "language": lang,
                            "error": err_msg,
                            "ts": datetime.now().isoformat(timespec="seconds"),
                        }
                        failed_records.append(rec)
                        if not args.retry_failed:
                            with FAILED_JSONL_PATH.open("a", encoding="utf-8") as f_fp:
                                f_fp.write(json.dumps(rec) + "\n")

                    elapsed = max(0.001, time.monotonic() - started_at)
                    rate = completed / elapsed
                    remaining_now = max(0, total_to_run - completed)
                    eta_str = _format_eta(remaining_now / rate if rate > 0 else None)
                    pct = (completed / total_to_run) * 100.0
                    _emit_line(
                        f"[{completed}/{total_to_run} | {pct:.1f}%] "
                        f"{item['mode']} #{item['problem_id']} ({lang}) {status_word} | "
                        f"{rate:.2f}/s | failed: {failed_count} | ETA: {eta_str}",
                        log_fp,
                    )
                    if not ok and consecutive_failures >= MAX_CONSECUTIVE_FAILURES and not circuit_tripped:
                        circuit_tripped = True
                        stop_event.set()
                        _emit_line(
                            f"Stopping early: {MAX_CONSECUTIVE_FAILURES} consecutive failures detected — "
                            "likely API quota exhausted. Resume after quota reset or key swap.",
                            log_fp,
                        )
                        for task in worker_tasks:
                            if not task.done():
                                task.cancel()

        worker_tasks = [asyncio.create_task(worker(item, lang)) for item, lang in tasks_meta]
        try:
            await asyncio.gather(*worker_tasks, return_exceptions=True)
        except (KeyboardInterrupt, asyncio.CancelledError):
            if not circuit_tripped:
                stop_event.set()
                _emit_line("Interrupted by user — waiting briefly for active DB writes to finish...", log_fp)
                for t in worker_tasks:
                    if not t.done():
                        t.cancel()
                await asyncio.gather(*worker_tasks, return_exceptions=True)

        if args.retry_failed and not stop_event.is_set():
            # Rewrite prewarm_failed.jsonl so succeeded retries are removed cleanly
            attempted_keys = {(item["mode"], item["problem_id"], lang) for item, lang in tasks_meta}
            remaining_failures: List[Dict[str, Any]] = []
            if FAILED_JSONL_PATH.exists():
                for raw_line in FAILED_JSONL_PATH.read_text(encoding="utf-8").splitlines():
                    if not raw_line.strip():
                        continue
                    try:
                        old_rec = json.loads(raw_line)
                        old_key = (
                            normalize_mode(old_rec.get("mode")),
                            int(old_rec["problem_id"]),
                            _resolve_language_config(old_rec.get("language"))[0],
                        )
                        if old_key not in attempted_keys:
                            remaining_failures.append(old_rec)
                    except Exception:
                        continue
            remaining_failures.extend(failed_records)
            with FAILED_JSONL_PATH.open("w", encoding="utf-8") as f_fp:
                for rec in remaining_failures:
                    f_fp.write(json.dumps(rec) + "\n")

        total_elapsed = max(0.001, time.monotonic() - started_at)
        _emit_line(
            f"Run finished in {_format_eta(total_elapsed)}: {succeeded} cached, {failed_count} failed.",
            log_fp,
        )
        return 0 if failed_count == 0 else 1


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Pre-warm LintIQ's permanent multi-language translation cache cleanly."
    )
    parser.add_argument(
        "--mode",
        default="all",
        choices=["interview", "practice", "all"],
        help="Catalog scope (default: all — processes interview 750 first, then practice 1,552).",
    )
    parser.add_argument(
        "--langs",
        default=",".join(DEFAULT_LANGS),
        help="Comma-separated target languages (default: java,cpp,javascript,typescript,go).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Maximum parallel translation workers (default: 4).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.25,
        help="Per-worker cooldown delay in seconds after each request (default: 0.25).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional cap on new translations to generate in this run.",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry failed (mode, problem_id, language) entries recorded in backend/prewarm_failed.jsonl.",
    )
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        return asyncio.run(run_prewarm(args))
    except KeyboardInterrupt:
        print("\nInterrupted cleanly — exiting.", flush=True)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
