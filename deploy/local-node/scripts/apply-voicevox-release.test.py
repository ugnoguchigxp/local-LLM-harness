import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path


spec = importlib.util.spec_from_file_location("voicevox_release", Path(__file__).with_name("apply-voicevox-release.py"))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
PREVIOUS, NEXT, FOREIGN = "a" * 40, "b" * 40, "c" * 40
REVISION, DIGEST = "d" * 64, "e" * 64


class FakeSystem(module.System):
    def __init__(self, paths):
        self.paths = paths
        self.commands = []
        self.requests = []
        self.clock = 0
        self.running = False
        self.auth_failure = False
        self.auth_change = False
        self.rollback_failure = False
        self.wrong_previous = False
        self.bad_audio = False
        self.reject_restart = False
        self.busy_count = 0

    def now(self):
        return self.clock

    def sleep(self, seconds):
        self.clock += seconds

    def authenticate(self):
        self.commands.append(["authenticate"])
        if self.auth_failure:
            raise module.DeploymentError("Administrator authentication failed")
        if self.auth_change:
            self.set_current(FOREIGN)

    def set_current(self, commit):
        link = self.paths.apps / "larm-current"
        link.unlink(missing_ok=True)
        link.symlink_to(self.paths.release(commit))

    def activator_running(self):
        return self.running

    def run(self, command, **kwargs):
        self.commands.append(command)
        if command[:3] == ["sudo", "-n", "cat"]:
            return str(self.paths.release(FOREIGN if self.wrong_previous else PREVIOUS))
        if command[-1] == "/usr/local/libexec/larm/rollback-larm-release":
            if self.rollback_failure:
                raise module.DeploymentError("Rollback helper failed")
            if signal.getsignal(signal.SIGINT) != signal.SIG_IGN:
                raise AssertionError("recovery is interruptible")
            self.set_current(PREVIOUS)
        if command[-2:] == ["restart", "voicevox-tts.service"] and self.reject_restart:
            raise module.DeploymentError("Restart failed")
        return ""

    def request(self, base, path, *, body=None, token=None):
        self.requests.append((base, path, body, token))
        if path == "/ready":
            return 200, {}, b'{"status":"ready"}'
        if path == "/health":
            if base.endswith(":8084"):
                return 200, {}, b'{"status":"healthy"}'
            current = (self.paths.apps / "larm-current").resolve().name
            commit = {PREVIOUS[:12]: PREVIOUS, NEXT[:12]: NEXT, FOREIGN[:12]: FOREIGN}[current]
            return 200, {}, json.dumps({"status": "ok", "releaseCommit": commit, "configRevision": REVISION}).encode()
        if body["input"] == "。":
            if self.busy_count:
                self.busy_count -= 1
                return 429, {"Retry-After": "9"}, b"busy"
            return 422, {}, b'{"error":{"code":"speech_text_unprocessable"}}'
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"\x00\x00" * 16)
        return 200, {"Content-Type": "audio/wav"}, b"invalid WAV" if self.bad_audio else output.getvalue()


class FakeDeployment(module.Deployment):
    def __init__(self, paths, system):
        super().__init__(paths, system)
        self.failure = None
        self.published_links = None
        self.foreign_status = False

    def publish(self, payload):
        super().publish(payload)
        self.published_links = (self.paths.inbox / "request.json").stat().st_nlink

    def wait_activation(self, approval):
        self.system.set_current(NEXT)
        status = {"operationId": "foreign" if self.foreign_status else DIGEST, "desiredRelease": NEXT,
            "observedRelease": NEXT, "result": "succeeded"}
        (self.paths.state / "status.json").write_text(json.dumps(status))
        (self.paths.inbox / "request.json").unlink()
        if self.failure:
            raise self.failure


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.paths = module.Paths(root / "apps", root / "state", root / "inbox", root / "public.pem", root / "env")
        for directory in (self.paths.state, self.paths.inbox):
            directory.mkdir(parents=True)
        for commit in (PREVIOUS, NEXT, FOREIGN):
            release = self.paths.release(commit)
            release.mkdir(parents=True)
            (release / "release-manifest.json").write_text(json.dumps({"commit": commit, "configRevision": REVISION}))
        self.paths.environment.write_text("LARM_API_TOKEN=fixture-only-token\n")
        (self.paths.state / "status.json").write_text(json.dumps({"observedRelease": PREVIOUS,
            "desiredRelease": PREVIOUS, "result": "succeeded"}))
        self.system = FakeSystem(self.paths)
        self.system.set_current(PREVIOUS)
        self.deployment = FakeDeployment(self.paths, self.system)
        self.approval = module.Approval(b'{"fixture":"signed request"}', NEXT, DIGEST, REVISION)

    def tearDown(self):
        self.temporary.cleanup()

    def rollback_calls(self):
        return [command for command in self.system.commands if command[-1] == "/usr/local/libexec/larm/rollback-larm-release"]

    def test_success_publishes_single_link_and_keeps_token_off_backend(self):
        self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(self.deployment.published_links, 1)
        self.assertEqual(self.deployment.current(), self.paths.release(NEXT))
        self.assertFalse(self.rollback_calls())
        speech = [request for request in self.system.requests if request[1] == "/v1/audio/speech"]
        self.assertEqual([request[3] for request in speech], [None, None, "fixture-only-token", "fixture-only-token"])

    def test_authentication_failure_never_submits(self):
        self.system.auth_failure = True
        with self.assertRaises(module.DeploymentError):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse((self.paths.inbox / "request.json").exists())
        self.assertEqual(self.deployment.current(), self.paths.release(PREVIOUS))

    def test_release_change_during_authentication_stops_before_submit(self):
        self.system.auth_change = True
        with self.assertRaises(module.DeploymentError):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse((self.paths.inbox / "request.json").exists())

    def test_pending_request_is_never_overwritten(self):
        pending = self.paths.inbox / "request.json"
        pending.write_bytes(b"another request")
        with self.assertRaises(FileExistsError):
            self.deployment.publish(self.approval.payload)
        self.assertEqual(pending.read_bytes(), b"another request")
        self.assertEqual(list(self.paths.inbox.glob(".voicevox-fix-*")), [])

    def test_interrupt_immediately_after_publish_is_reported_as_pending(self):
        original = self.deployment.publish
        def interrupted(payload):
            original(payload)
            raise KeyboardInterrupt("interrupted after publish")
        self.deployment.publish = interrupted
        with self.assertRaisesRegex(module.DeploymentError, "recovery incomplete: Activation is still pending"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual((self.paths.inbox / "request.json").read_bytes(), self.approval.payload)
        self.assertFalse(self.rollback_calls())

    def test_concurrent_apply_is_rejected_before_authentication(self):
        import fcntl
        with open(self.paths.inbox / ".voicevox-apply.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse(self.system.commands)

    def test_provider_restart_failure_reports_recovery_failure(self):
        self.system.reject_restart = True
        with self.assertRaisesRegex(module.DeploymentError, "recovery incomplete: Restart failed"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(len(self.rollback_calls()), 1)
        self.assertEqual(self.deployment.current(), self.paths.release(PREVIOUS))

    def test_timeout_after_activation_restores_previous(self):
        self.deployment.failure = module.DeploymentError("activation timed out")
        with self.assertRaisesRegex(module.DeploymentError, "Previous release and VOICEVOX process restored"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(len(self.rollback_calls()), 1)
        self.assertEqual(self.deployment.current(), self.paths.release(PREVIOUS))

    def test_interrupt_restores_previous_and_restores_signal_handlers(self):
        handlers = [signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)]
        self.deployment.failure = KeyboardInterrupt("interrupted")
        with self.assertRaisesRegex(module.DeploymentError, "Previous release and VOICEVOX process restored"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(len(self.rollback_calls()), 1)
        self.assertEqual(handlers, [signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)])

    def test_running_activator_is_not_rolled_back_concurrently(self):
        self.deployment.failure = module.DeploymentError("activation timed out")
        self.system.running = True
        with self.assertRaisesRegex(module.DeploymentError, "recovery incomplete: Activator is still running"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse(self.rollback_calls())

    def test_foreign_operation_is_not_rolled_back(self):
        self.deployment.foreign_status = True
        self.deployment.failure = module.DeploymentError("operation changed")
        with self.assertRaisesRegex(module.DeploymentError, "Cannot roll back a different release operation"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse(self.rollback_calls())

    def test_changed_rollback_target_is_not_used(self):
        self.deployment.failure = module.DeploymentError("activation timed out")
        self.system.wrong_previous = True
        with self.assertRaisesRegex(module.DeploymentError, "Rollback target changed"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertFalse(self.rollback_calls())

    def test_rollback_failure_is_reported_and_does_not_restart_candidate(self):
        self.deployment.failure = module.DeploymentError("activation timed out")
        self.system.rollback_failure = True
        with self.assertRaisesRegex(module.DeploymentError, "recovery incomplete: Rollback helper failed"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(len(self.rollback_calls()), 1)
        self.assertFalse(any(command[-2:] == ["restart", "voicevox-tts.service"] for command in self.system.commands))

    def test_invalid_audio_triggers_rollback(self):
        self.system.bad_audio = True
        with self.assertRaisesRegex(module.DeploymentError, "Previous release and VOICEVOX process restored"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(len(self.rollback_calls()), 1)

    def test_busy_provider_retries_before_verifying_input_error(self):
        self.system.busy_count = 2
        self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(self.system.busy_count, 0)
        self.assertEqual(self.system.clock, 10)

    def test_busy_retry_exhaustion_restores_previous(self):
        self.system.busy_count = 6
        with self.assertRaisesRegex(module.DeploymentError, "HTTP 429; Previous release"):
            self.deployment.apply(self.approval, PREVIOUS)
        self.assertEqual(self.system.busy_count, 0)
        self.assertEqual(self.system.clock, 25)
        self.assertEqual(len(self.rollback_calls()), 1)

    def test_already_applied_release_can_finish_provider_restart(self):
        self.deployment.apply(self.approval, PREVIOUS)
        self.deployment.published_links = None
        self.deployment.apply(self.approval, PREVIOUS)
        self.assertIsNone(self.deployment.published_links)

    def test_status_from_another_manifest_does_not_complete_wait(self):
        self.system.set_current(NEXT)
        (self.paths.state / "status.json").write_text(json.dumps({"operationId": "foreign",
            "desiredRelease": NEXT, "observedRelease": NEXT, "result": "succeeded"}))
        with self.assertRaisesRegex(module.DeploymentError, "timed out"):
            module.Deployment(self.paths, self.system).wait_activation(self.approval)

    def test_redirects_are_rejected(self):
        with self.assertRaisesRegex(module.DeploymentError, "redirect"):
            module.NoRedirects().redirect_request(None, None, 302, "Found", {}, "https://example.invalid")

    def test_local_http_ignores_proxy_environment_and_bounds_responses(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from threading import Thread
        from unittest.mock import patch
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                self.send_response(302 if self.path == "/redirect" else 200)
                if self.path == "/redirect":
                    self.send_header("Location", "/unexpected-target")
                self.end_headers()
                self.wfile.write(b"x" * 65537 if self.path == "/oversized" else b"{}")
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": ""}):
                system = module.System()
                base = f"http://127.0.0.1:{server.server_port}"
                self.assertEqual(system.request(base, "/health")[0], 200)
                with self.assertRaisesRegex(module.DeploymentError, "redirect"):
                    system.request(base, "/redirect", token="fixture-only-token")
                with self.assertRaisesRegex(module.DeploymentError, "exceeds"):
                    system.request(base, "/oversized")
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_signature_and_manifest_are_actually_verified(self):
        key = Path(self.temporary.name) / "private.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(key)], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(self.paths.public_key)], check=True, capture_output=True)
        candidate = self.paths.apps / "larm-candidates" / NEXT
        candidate.mkdir(parents=True)
        manifest = candidate / "release-manifest.json"
        manifest.write_text(json.dumps({"schemaVersion": 2, "commit": NEXT, "configRevision": REVISION}))
        intent = {"schemaVersion": 1, "commit": NEXT, "candidatePath": str(candidate),
            "manifestSha256": module.hashlib.sha256(manifest.read_bytes()).hexdigest(), "requestedAt": "2026-10-09T00:00:00Z"}
        canonical = (json.dumps(intent, sort_keys=True, separators=(",", ":")) + "\n").encode()
        signature = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key)], input=canonical, check=True, capture_output=True).stdout
        import base64
        request = Path(self.temporary.name) / "signed.json"
        request.write_text(json.dumps({"schemaVersion": 1, "intent": intent, "signature": base64.b64encode(signature).decode()}))
        deployment = module.Deployment(self.paths, module.System())
        self.assertEqual(deployment.approval(request).commit, NEXT)
        manifest.write_text("changed")
        with self.assertRaisesRegex(module.DeploymentError, "Signed manifest digest changed"):
            deployment.approval(request)
        document = json.loads(request.read_text())
        document["intent"]["manifestSha256"] = "0" * 64
        request.write_text(json.dumps(document))
        with self.assertRaisesRegex(module.DeploymentError, "Command failed: openssl"):
            deployment.approval(request)


if __name__ == "__main__":
    unittest.main()
