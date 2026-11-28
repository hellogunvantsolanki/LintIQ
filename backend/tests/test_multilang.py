import shutil
import sys
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import database  # noqa: E402
import main  # noqa: E402
import runner  # noqa: E402
import translator  # noqa: E402


def test_strip_comments_preserves_strings_and_urls():
    py_src = (
        'url = "https://example.com#frag"  # remove me\n'
        "# full comment\n"
        "def f(x):\n"
        "    return x + 1\n"
    )
    cleaned_py = runner.strip_language_comments(py_src, "python")
    assert "remove me" not in cleaned_py
    assert "full comment" not in cleaned_py
    assert "https://example.com#frag" in cleaned_py

    cpp_src = (
        '// top comment\n'
        '#include <iostream>\n'
        '/* multi\n'
        '   line block */\n'
        'int main() {\n'
        '    const char* s = "http://site.dev/*keep*/ //ok"; // trailing note\n'
        '    std::cout << s;\n'
        '}\n'
    )
    cleaned_cpp = runner.strip_language_comments(cpp_src, "cpp")
    assert "top comment" not in cleaned_cpp
    assert "multi" not in cleaned_cpp
    assert "trailing note" not in cleaned_cpp
    assert '"http://site.dev/*keep*/ //ok"' in cleaned_cpp


def test_validate_minimal_patch_across_all_6_languages():
    samples = {
        "python": (
            "n = int(input())\nprint(n - 1)\n",
            "n = int(input())\nprint(n + 1)\n",
            "n = int(input())\nprint(n - 1)  # comment\n",
            "n = int(\n",
        ),
        "java": (
            "public class Solution {\n  public static void main(String[] args) {\n    int x = 1;\n    System.out.println(x - 1);\n  }\n}\n",
            "public class Solution {\n  public static void main(String[] args) {\n    int x = 1;\n    System.out.println(x + 1);\n  }\n}\n",
            "public class Solution {\n  public static void main(String[] args) {\n    int x = 1;\n    System.out.println(x - 1); // hint\n  }\n}\n",
            "public class Solution {\n  public static void main(String[] args) {\n",
        ),
        "cpp": (
            "#include <iostream>\nint main() {\n  int n = 2;\n  std::cout << (n - 1);\n}\n",
            "#include <iostream>\nint main() {\n  int n = 2;\n  std::cout << (n + 1);\n}\n",
            "#include <iostream>\nint main() {\n  int n = 2;\n  std::cout << (n - 1); /* ok */\n}\n",
            "#include <iostream>\nint main() {\n  std::cout << \"unterminated;\n}\n",
        ),
        "javascript": (
            "const n = 2;\nconsole.log(n - 1);\n",
            "const n = 2;\nconsole.log(n + 1);\n",
            "const n = 2;\nconsole.log(n - 1); // noop\n",
            "function broken( {\n",
        ),
        "typescript": (
            "const n: number = 2;\nconsole.log(n - 1);\n",
            "const n: number = 2;\nconsole.log(n + 1);\n",
            "const n: number = 2;\nconsole.log(n - 1); /* noop */\n",
            "const s: string = 'unclosed;\n",
        ),
        "go": (
            "package main\nimport \"fmt\"\nfunc main() {\n  n := 2\n  fmt.Println(n - 1)\n}\n",
            "package main\nimport \"fmt\"\nfunc main() {\n  n := 2\n  fmt.Println(n + 1)\n}\n",
            "package main\nimport \"fmt\"\nfunc main() {\n  n := 2\n  fmt.Println(n - 1) // comment\n}\n",
            "package main\nfunc main() {\n",
        ),
    }

    for lang, (orig, valid_edit, comment_only, broken) in samples.items():
        ok = runner.validate_minimal_patch(orig, valid_edit, language=lang)
        assert ok["valid"] is True, f"{lang} surgical patch unexpectedly rejected: {ok}"
        assert ok["changed_lines"] == 1

        unchanged = runner.validate_minimal_patch(orig, comment_only, language=lang)
        assert unchanged["valid"] is True
        assert unchanged["changed_lines"] == 0

        rewrite = "\n".join(f"line_{i} = {i}" for i in range(40))
        excessive = runner.validate_minimal_patch(orig, rewrite, language=lang)
        assert excessive["valid"] is False
        assert excessive["reason"] == "rewrite_detected"

        broken_check = runner.validate_minimal_patch(orig, broken, language=lang)
        assert "valid" in broken_check


def test_translator_three_tier_permanent_cache(tmp_path, monkeypatch):
    temp_variants_db = tmp_path / "language_variants.db"
    monkeypatch.setattr(database, "LANGUAGE_VARIANTS_DB_PATH", temp_variants_db)
    monkeypatch.setattr(translator, "_MEM_TRANSLATION_CACHE", {})
    monkeypatch.setattr(translator, "fetch_supabase_problem_translation", lambda *a, **kw: None)
    monkeypatch.setattr(translator, "save_supabase_problem_translation", lambda *a, **kw: False)
    monkeypatch.setattr(translator, "_load_env_key", lambda: "test-key")

    llm_calls = []

    def fake_gemini_api(api_key, prompt, temperature=0.15):
        llm_calls.append(len(prompt))
        return {
            "code": (
                "```cpp\n"
                "// debug note that should be stripped\n"
                "#include <iostream>\n"
                "int main() {\n"
                "    int n; std::cin >> n;\n"
                "    std::cout << n * (n - 1) / 2 << std::endl;\n"
                "    return 0;\n"
                "}\n"
                "```"
            )
        }

    monkeypatch.setattr(translator, "_call_gemini_api", fake_gemini_api)

    first = translator.get_or_translate_problem_code(
        mode="practice",
        problem_id=3,
        language="cpp",
        python_buggy_code="n = int(input())\nprint(n * (n - 1) // 2)\n",
        title="Sum of First N",
    )
    assert len(llm_calls) == 1
    assert "debug note" not in first
    assert "#include <iostream>" in first

    # Tier 1 hit: memory cache -> 0 LLM calls
    second = translator.get_or_translate_problem_code(
        mode="practice",
        problem_id=3,
        language="cpp",
        python_buggy_code="ignored",
    )
    assert second == first
    assert len(llm_calls) == 1

    # Clear Tier 1 memory -> Tier 3 SQLite permanent cache hits cleanly with 0 LLM calls
    translator._MEM_TRANSLATION_CACHE.clear()
    third = translator.get_or_translate_problem_code(
        mode="practice",
        problem_id=3,
        language="cpp",
        python_buggy_code="ignored",
    )
    assert third == first
    assert len(llm_calls) == 1


def test_api_get_problem_backward_compat_and_multilang(tmp_path, monkeypatch):
    temp_variants_db = tmp_path / "language_variants.db"
    monkeypatch.setattr(database, "LANGUAGE_VARIANTS_DB_PATH", temp_variants_db)
    monkeypatch.setattr(translator, "_MEM_TRANSLATION_CACHE", {})
    monkeypatch.setattr(translator, "fetch_supabase_problem_translation", lambda *a, **kw: None)
    monkeypatch.setattr(translator, "save_supabase_problem_translation", lambda *a, **kw: False)

    calls = {"n": 0}

    def fake_gemini(canonical_lang, python_buggy_code, title="", description="", test_cases=None):
        calls["n"] += 1
        return "const fs = require('fs');\nconsole.log(fs.readFileSync(0, 'utf8').trim());\n"

    monkeypatch.setattr(translator, "_translate_via_gemini", fake_gemini)

    client = TestClient(main.app)

    res_default = client.get("/problems/3?mode=practice")
    assert res_default.status_code == 200
    d_default = res_default.json()
    assert d_default["language"] == "python"
    assert isinstance(d_default["buggy_code"], str) and len(d_default["buggy_code"]) > 0
    assert calls["n"] == 0

    res_bad_lang = client.get("/problems/3?mode=practice&lang=ruby")
    assert res_bad_lang.status_code == 400

    res_js_1 = client.get("/problems/3?mode=practice&lang=javascript")
    assert res_js_1.status_code == 200
    d_js_1 = res_js_1.json()
    assert d_js_1["language"] == "javascript"
    assert "console.log" in d_js_1["buggy_code"]
    assert calls["n"] == 1

    # Second hit must come from permanent cache with zero extra LLM calls
    res_js_2 = client.get("/problems/3?mode=practice&lang=javascript")
    assert res_js_2.status_code == 200
    assert res_js_2.json()["buggy_code"] == d_js_1["buggy_code"]
    assert calls["n"] == 1


def test_runner_local_multi_runtime_and_missing_compiler_graceful(monkeypatch):
    monkeypatch.setenv("ALLOW_LOCAL_SANDBOX", "true")
    monkeypatch.delenv("ONLINECOMPILER_API_KEY", raising=False)
    monkeypatch.delenv("JUDGE0_API_KEY", raising=False)

    py_run = runner.run_custom_code("n = int(input())\nprint(n * 2)\n", stdin_data="21\n", language="python")
    assert py_run["ok"] is True
    assert py_run["stdout"].strip() == "42"

    if shutil.which("node"):
        js_run = runner.run_custom_code(
            "const fs = require('fs');\nconst n = Number(fs.readFileSync(0, 'utf8').trim());\nconsole.log(n * 2);\n",
            stdin_data="21\n",
            language="javascript",
        )
        assert js_run["ok"] is True
        assert js_run["stdout"].strip() == "42"

        js_eval = runner.evaluate_patch(
            user_code="const fs = require('fs');\nconst n = Number(fs.readFileSync(0, 'utf8').trim());\nconsole.log(n + 1);\n",
            test_cases=[{"input": "4\n", "expected_output": "5"}],
            language="javascript",
            starter_code="const fs = require('fs');\nconst n = Number(fs.readFileSync(0, 'utf8').trim());\nconsole.log(n - 1);\n",
        )
        assert js_eval["passed"] is True

    # Missing compiler (simulate Go unavailable) must fail gracefully without unhandled traceback
    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda cmd: None if cmd == "go" else real_which(cmd))
    go_missing = runner.run_custom_code(
        'package main\nimport "fmt"\nfunc main(){ fmt.Println(1) }\n',
        language="go",
    )
    assert go_missing["ok"] is False
    assert "unavailable" in go_missing["stderr"].lower()

    go_eval = runner.evaluate_patch(
        user_code='package main\nimport "fmt"\nfunc main(){ fmt.Println(2) }\n',
        test_cases=[{"input": "", "expected_output": "2"}],
        language="go",
        starter_code='package main\nimport "fmt"\nfunc main(){ fmt.Println(1) }\n',
    )
    assert go_eval["passed"] is False
    assert "unavailable" in go_eval["message"].lower()


def test_api_run_and_submit_aliases_with_translated_baseline(tmp_path, monkeypatch):
    if not shutil.which("node"):
        return
    temp_variants_db = tmp_path / "language_variants.db"
    monkeypatch.setattr(database, "LANGUAGE_VARIANTS_DB_PATH", temp_variants_db)
    monkeypatch.setattr(translator, "_MEM_TRANSLATION_CACHE", {})
    monkeypatch.setattr(translator, "fetch_supabase_problem_translation", lambda *a, **kw: None)
    monkeypatch.setattr(translator, "save_supabase_problem_translation", lambda *a, **kw: False)
    monkeypatch.setenv("ALLOW_LOCAL_SANDBOX", "true")
    monkeypatch.delenv("ONLINECOMPILER_API_KEY", raising=False)
    monkeypatch.delenv("JUDGE0_API_KEY", raising=False)

    main._RUN_RATE_BUCKETS.clear()
    main._SUBMIT_RATE_BUCKETS.clear()

    # Problem 1 in practice DB: Sum of First N Natural Numbers (buggy: N*(N-1)//2)
    js_starter = (
        "const fs = require('fs');\n"
        "const n = Number(fs.readFileSync(0, 'utf8').trim());\n"
        "console.log((n * (n - 1)) / 2);\n"
    )
    js_fixed = (
        "const fs = require('fs');\n"
        "const n = Number(fs.readFileSync(0, 'utf8').trim());\n"
        "console.log((n * (n + 1)) / 2);\n"
    )
    database.save_sqlite_problem_translation("practice", 1, "javascript", js_starter)

    client = TestClient(main.app)
    run_resp = client.post(
        "/run",
        json={"problem_id": 1, "user_code": js_fixed, "stdin": "5\n", "language": "javascript", "mode": "practice"},
    )
    assert run_resp.status_code == 200
    assert run_resp.json()["stdout"].strip() == "15"
    assert "patch_warning" not in run_resp.json()

    # Mock authenticated submit baseline check against translated JS starter
    monkeypatch.setattr(main, "verify_supabase_token", lambda tok: {"id": "11111111-1111-1111-1111-111111111111", "username": "Tester"})
    monkeypatch.setattr(main, "record_user_solve", lambda **kw: {"id": kw["user_id"], "username": "Tester", "score": 100, "streak": 1, "solves": 1})
    monkeypatch.setattr(main, "_has_solved_daily_today", lambda **kw: False)

    headers = {"Authorization": "Bearer fake-token"}
    submit_ok = client.post(
        "/submit",
        headers=headers,
        json={"problem_id": 1, "user_code": js_fixed, "language": "javascript", "mode": "practice"},
    )
    assert submit_ok.status_code == 200
    assert submit_ok.json()["passed"] is True

    main._SUBMIT_RATE_BUCKETS.clear()
    rewrite_js = "\n".join(f"const x{i} = {i};" for i in range(25)) + "\nconsole.log(15);\n"
    submit_reject = client.post(
        "/submit",
        headers=headers,
        json={"problem_id": 1, "user_code": rewrite_js, "language": "javascript", "mode": "practice"},
    )
    assert submit_reject.status_code == 200
    assert submit_reject.json()["passed"] is False
    assert submit_reject.json()["rejected_reason"] == "rewrite_detected"


def test_translator_model_order_and_real_api_error_propagation(monkeypatch):
    import pytest

    assert translator.TRANSLATION_MODELS[0] != "gemini-3-flash-preview"
    assert translator.TRANSLATION_MODELS[-1] == "gemini-3-flash-preview"
    assert translator.TRANSLATION_TIMEOUT_SEC == 15.0

    monkeypatch.setattr(translator, "_load_env_key", lambda: "test-key")
    monkeypatch.setattr(translator, "_call_gemini_api", translator._DEFAULT_CALL_GEMINI_API)

    class _FakeResp:
        def __init__(self, status_code, body):
            self.status_code = status_code
            self._body = body
            self.text = str(body)

        def json(self):
            return self._body

    def fake_post(url, json=None, headers=None):
        return _FakeResp(
            429,
            {
                "error": {
                    "code": 429,
                    "message": "Quota exceeded for quota metric 'Generate Content API requests per day'.",
                    "status": "RESOURCE_EXHAUSTED",
                }
            },
        )

    monkeypatch.setattr(translator._TRANSLATION_HTTP, "post", fake_post)

    with pytest.raises(RuntimeError) as exc_info:
        translator._translate_via_gemini(
            canonical_lang="cpp",
            python_buggy_code="print(1)\n",
        )

    err_text = str(exc_info.value)
    assert "429" in err_text
    assert "RESOURCE_EXHAUSTED" in err_text
    assert "Empty translation" not in err_text


def test_prewarm_circuit_breaker_stops_after_15_consecutive_failures(tmp_path, monkeypatch):
    import argparse
    import asyncio
    import prewarm_cache

    temp_variants_db = tmp_path / "language_variants.db"
    monkeypatch.setattr(database, "LANGUAGE_VARIANTS_DB_PATH", temp_variants_db)
    monkeypatch.setattr(prewarm_cache, "FAILED_JSONL_PATH", tmp_path / "prewarm_failed.jsonl")
    monkeypatch.setattr(prewarm_cache, "LOG_FILE_PATH", tmp_path / "prewarm.log")
    monkeypatch.setattr(prewarm_cache, "RETRY_BACKOFFS_SEC", (0.0,))

    calls = {"n": 0}

    async def always_fail(**kwargs):
        calls["n"] += 1
        raise RuntimeError("429 RESOURCE_EXHAUSTED")

    monkeypatch.setattr(prewarm_cache, "get_or_translate_problem_code_async", always_fail)

    args = argparse.Namespace(
        mode="interview",
        langs="cpp",
        concurrency=3,
        delay=0.0,
        limit=40,
        retry_failed=False,
    )
    rc = asyncio.run(prewarm_cache.run_prewarm(args))
    assert rc == 1
    assert 15 <= calls["n"] < 40
    log_text = (tmp_path / "prewarm.log").read_text(encoding="utf-8")
    assert "15 consecutive failures" in log_text



