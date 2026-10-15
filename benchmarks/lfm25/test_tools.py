"""Infrastructure checks only: fake loopback SSE, no model weights or inference."""

import contextlib
import copy
import hashlib
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest

from client import loopback_url, stream
from replay import replay
from report import BASELINE, markdown, summarize
from run import FROZEN_SHA256, extra_arguments

HERE = pathlib.Path(__file__).resolve().parent


@contextlib.contextmanager
def events(chunks, status=200):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(status)
            self.end_headers()
            if status != 200:
                self.wfile.write(b'{"error":"test error"}')
                return
            for chunk in chunks:
                value = chunk if isinstance(chunk, str) else json.dumps(chunk, ensure_ascii=False)
                self.wfile.write(("data: " + value + "\n\n").encode())

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class ProtocolTests(unittest.TestCase):
    def test_fragmented_tools_reasoning_and_usage(self):
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "考え"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "id0", "function": {"name": "search_", "arguments": '{"q":"'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "documents", "arguments": '日本語"}'}}]}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"completion_tokens": 9}, "timings": {"predicted_per_second": 20}},
            "[DONE]",
        ]
        with events(chunks) as base:
            row = stream(base, {"stream": True})
        self.assertNotIn("error", row)
        self.assertEqual(row["reasoning"], "考え")
        self.assertIsNone(row["firstContentMs"])
        self.assertIsNotNone(row["firstToolMs"])
        self.assertEqual(row["toolCalls"][0]["function"], {"name": "search_documents", "arguments": '{"q":"日本語"}'})
        self.assertEqual(row["usage"]["completion_tokens"], 9)

    def test_truncated_stream_and_http_error_remain_failures(self):
        with events([{"choices": [{"delta": {"content": "途中"}}]}]) as base:
            row = stream(base, {})
        self.assertIn("finish reason", row["error"])
        with events([], 500) as base:
            self.assertIn("test error", stream(base, {})["error"])

    def test_replay_does_not_change_original_fixture(self):
        source = {"checks": [{"case": "schema-0", "request": {"model": "old", "messages": []}}]}
        original = copy.deepcopy(source)
        chunk = {"choices": [{"delta": {"content": "{}"}, "finish_reason": "stop"}]}
        with events([chunk]) as base:
            result = replay(base, source, ["schema-0"], [0, 1], "none", "new")
        self.assertEqual(source, original)
        self.assertEqual([r["request"]["seed"] for r in result["samples"]], [0, 1])
        self.assertEqual(result["samples"][0]["request"]["model"], "new")
        with self.assertRaisesRegex(ValueError, "missing"):
            replay("http://127.0.0.1:1", source, ["missing"])

    def test_reports_do_not_hide_empty_or_truncated_answers(self):
        raw = {"performance": [{"case": "history", "finishReason": "length", "content": "",
                                 "totalMs": 50000, "firstContentMs": None, "usage": {"completion_tokens": 4096}}]}
        summary = summarize(raw)
        self.assertFalse(summary["complete"])
        self.assertEqual(summary["performance"]["history"]["answers"], 0)
        self.assertEqual(summary["performance"]["history"]["truncated"], 1)
        self.assertIsNone(summary["performance"]["history"]["firstContentMsSuccessful"])
        self.assertIn("complete=False", markdown([summary]))

    def test_off_label_does_not_hide_generated_thoughts(self):
        summary = summarize({"thinking": "off", "warmup": {"reasoning": "still thinking", "content": "answer"}})
        self.assertEqual(summary["reasoningAudit"]["requested"], "off")
        self.assertEqual(summary["reasoningAudit"]["responsesWithReasoning"], 1)

    def test_baseline_and_suite_are_frozen(self):
        self.assertEqual(hashlib.sha256((HERE / "evaluate.py").read_bytes()).hexdigest(), FROZEN_SHA256)
        baseline = json.loads(BASELINE.read_text())
        self.assertEqual(len(baseline["runs"]), 3)
        lfm = baseline["runs"][0]
        self.assertEqual(lfm["configuration"]["historyContextPerSlot"], 16384)
        self.assertEqual(lfm["performance"]["history"]["answers"], 2)
        self.assertEqual(lfm["performance"]["history"]["outputTokens"], 3937)

    def test_endpoint_and_argument_guards(self):
        for value in ("https://example.com", "http://127.0.0.1:80/v1", "http://user@127.0.0.1:80"):
            with self.assertRaises(ValueError):
                loopback_url(value)
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "args.json"
            for value in (["--host=0.0.0.0"], ["--cache-type-k", "q4_0"], {"bad": True}):
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    extra_arguments(path)


FAKE_ENGINE = '''#!/usr/bin/env python3
import http.server,json,sys
if '--version' in sys.argv:
 print('fake engine, infrastructure test only');sys.exit(0)
def arg(name):return sys.argv[sys.argv.index(name)+1]
class Handler(http.server.BaseHTTPRequestHandler):
 calls=0
 def do_GET(self):
  self.send_response(200);self.end_headers()
  value={'status':'ok'} if self.path=='/health' else {'model_alias':arg('--alias'),'model_path':arg('-m')}
  if '--fake-wrong-alias' in sys.argv and self.path=='/props':value['model_alias']='wrong'
  self.wfile.write(json.dumps(value).encode())
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  self.send_response(200);self.end_headers()
  if self.path=='/tokenize':self.wfile.write(json.dumps({'tokens':list(range(600))}).encode());return
  if self.path=='/completion':self.wfile.write(json.dumps({'timings':{'predicted_per_second':100}}).encode());return
  row={'choices':[{'delta':{'content':'fixture-only'},'finish_reason':'stop'}],'usage':{'completion_tokens':2},'timings':{'predicted_per_second':100}}
  Handler.calls+=1
  if '--fake-leaks-after-preflight' in sys.argv and Handler.calls>1:row['choices'][0]['delta']['content']='thought</think>answer'
  if '--fake-thinks' in sys.argv:row['choices'][0]['delta']['reasoning_content']='still thinking'
  self.wfile.write(('data: '+json.dumps(row)+'\\n\\ndata: [DONE]\\n\\n').encode())
 def log_message(self,*args):pass
http.server.ThreadingHTTPServer(('127.0.0.1',int(arg('--port'))),Handler).serve_forever()
'''


class RunnerTests(unittest.TestCase):
    def exercise(self, tmp, extra=None, dry=False, thinking="on"):
        root = pathlib.Path(tmp)
        engine = root / "fake-engine"
        engine.write_text(FAKE_ENGINE)
        engine.chmod(0o755)
        weights = root / "fake-weights"
        weights.write_text("not model weights")
        output = root / "result"
        cmd = [sys.executable, str(HERE / "run.py"), "--engine", str(engine), "--weights", str(weights),
               "--label", "FAKE TEST ONLY", "--thinking", thinking, "--output-dir", str(output), "--diagnostics"]
        if extra:
            path = root / "args.json"
            path.write_text(json.dumps(extra))
            cmd += ["--extra-args-file", str(path)]
        if dry:
            cmd.append("--dry-run")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        return output, result

    def test_full_fake_run_produces_comparison_and_stops_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "complete")
            self.assertTrue(manifest["ownedProcessStopped"])
            self.assertEqual(len(json.loads((output / "evaluation.json").read_text())["checks"]), 68)
            self.assertTrue((output / "comparison.md").exists())
            self.assertTrue((output / "japanese-seeds.json").exists())
            self.assertTrue((output / "native-speed.json").exists())

    def test_wrong_listener_fails_and_owned_server_is_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp, ["--fake-wrong-alias"])
            self.assertNotEqual(result.returncode, 0)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "failed")
            self.assertTrue(manifest["ownedProcessStopped"])
            self.assertFalse((output / "evaluation.json").exists())

    def test_dry_run_creates_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp, dry=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(json.loads(result.stdout)["contextPerSlot"], 16384)

    def test_off_run_has_zero_budget_and_verified_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp, thinking="off")
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((output / "manifest.json").read_text())
            argv = manifest["command"]
            self.assertEqual(argv[argv.index("--reasoning-budget") + 1], "0")
            self.assertTrue(manifest["reasoningOffVerified"])
            self.assertEqual(manifest["reasoningAudit"]["responsesWithReasoning"], 0)
            self.assertEqual(manifest["comparisonBaseline"], "2026-10-15-reasoning-off.json")

    def test_ineffective_off_aborts_before_suite_and_stops_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp, ["--fake-thinks"], thinking="off")
            self.assertNotEqual(result.returncode, 0)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertFalse(manifest["reasoningOffVerified"])
            self.assertTrue(manifest["ownedProcessStopped"])
            self.assertFalse((output / "evaluation.json").exists())

    def test_later_thought_leak_is_preserved_and_invalidates_full_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            output, result = self.exercise(tmp, ["--fake-leaks-after-preflight"], thinking="off")
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertTrue(manifest["preflightReasoningOffVerified"])
            self.assertFalse(manifest["reasoningOffVerified"])
            self.assertEqual(manifest["status"], "complete")
            self.assertGreater(manifest["reasoningAudit"]["bodyThinkTagLeaks"], 0)
            self.assertTrue(manifest["ownedProcessStopped"])
            self.assertTrue((output / "evaluation.json").exists())


if __name__ == "__main__":
    unittest.main()
