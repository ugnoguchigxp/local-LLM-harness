#!/usr/bin/env python3
"""Apply a signed LARM release and verify the reloaded VOICEVOX provider."""
from __future__ import annotations

import argparse
import base64
import ctypes
import fcntl
import hashlib
import io
import json
import os
import re
import shlex
import signal
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path


class DeploymentError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DeploymentError(message)


def read_regular(path: Path, limit: int = 65536) -> bytes:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
        require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), "Expected a regular file")
        payload = handle.read(limit + 1)
    require(len(payload) <= limit, "File exceeds its size limit")
    return payload


@dataclass(frozen=True)
class Paths:
    apps: Path = Path("/srv/ai/apps")
    state: Path = Path("/var/lib/larm/release-controller")
    inbox: Path = Path("/var/lib/larm/release-inbox")
    public_key: Path = Path("/etc/larm/release-signing.pub")
    environment: Path = Path("/etc/larm/larm.env")

    def release(self, commit: str) -> Path:
        return self.apps / "larm-releases" / commit[:12]


@dataclass(frozen=True)
class Approval:
    payload: bytes
    commit: str
    manifest_digest: str
    config_revision: str


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise DeploymentError("Local verification endpoint attempted a redirect")


class System:
    now = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    def __init__(self):
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())

    def run(self, command: list[str], *, data: bytes | None = None) -> str:
        result = subprocess.run(command, input=data, capture_output=True)
        require(result.returncode == 0, f"Command failed: {' '.join(command)} (exit {result.returncode})")
        return result.stdout.decode().strip()

    def authenticate(self) -> None:
        # Keep the password prompt on the terminal, never in captured output.
        require(subprocess.run(["sudo", "-v"]).returncode == 0, "Administrator authentication failed; nothing submitted")

    def activator_running(self) -> bool:
        state = self.run(["systemctl", "show", "--property=ActiveState", "--value", "larm-release-activator.service"])
        require(state in {"active", "activating", "reloading", "deactivating", "inactive", "failed"},
            "Cannot determine release activator state")
        return state not in {"inactive", "failed"}

    def request(self, base: str, path: str, *, body: dict | None = None, token: str | None = None):
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(base + path,
            data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = self.http.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            limit = 16 * 1024 * 1024 if path == "/v1/audio/speech" else 65536
            payload = response.read(limit + 1)
            require(len(payload) <= limit, "Local verification response exceeds its size limit")
            return response.code, response.headers, payload


class Deployment:
    def __init__(self, paths: Paths = Paths(), system: System | None = None):
        self.paths = paths
        self.system = system or System()

    def current(self) -> Path:
        link = self.paths.apps / "larm-current"
        require(link.is_symlink(), "Active release pointer is unavailable")
        return link.resolve(strict=True)

    def status(self) -> dict:
        return json.loads(read_regular(self.paths.state / "status.json"))

    def approval(self, request: Path) -> Approval:
        payload = read_regular(request)
        document = json.loads(payload)
        require(set(document) == {"schemaVersion", "intent", "signature"} and document["schemaVersion"] == 1,
            "Invalid signed request schema")
        intent = document["intent"]
        require(set(intent) == {"schemaVersion", "commit", "candidatePath", "manifestSha256", "requestedAt"}
            and intent["schemaVersion"] == 1, "Invalid release intent schema")
        commit, digest = intent["commit"], intent["manifestSha256"]
        require(isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{40}", commit) is not None, "Invalid commit")
        require(isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest) is not None, "Invalid manifest digest")
        canonical = (json.dumps(intent, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
        with tempfile.TemporaryDirectory(prefix="larm-voicevox-signature-") as temporary:
            signature = Path(temporary) / "signature.bin"
            signature.write_bytes(base64.b64decode(document["signature"], validate=True))
            self.system.run(["openssl", "dgst", "-sha256", "-verify", str(self.paths.public_key),
                "-signature", str(signature)], data=canonical)
        candidate = self.paths.apps / "larm-candidates" / commit
        require(intent["candidatePath"] == str(candidate) and candidate.resolve(strict=True) == candidate,
            "Candidate is outside its fixed release slot")
        manifest_bytes = read_regular(candidate / "release-manifest.json")
        require(hashlib.sha256(manifest_bytes).hexdigest() == digest, "Signed manifest digest changed")
        manifest = json.loads(manifest_bytes)
        require(manifest["schemaVersion"] == 2 and manifest["commit"] == commit, "Candidate identity mismatch")
        revision = manifest["configRevision"]
        require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{64}", revision) is not None, "Invalid config revision")
        return Approval(payload, commit, digest, revision)

    def preflight(self, approval: Approval, previous: str) -> bool:
        require(re.fullmatch(r"[a-f0-9]{40}", previous) is not None and previous != approval.commit, "Invalid previous commit")
        current, status = self.current(), self.status()
        already_active = current == self.paths.release(approval.commit)
        if already_active:
            require(self.owned_status(status, approval) and status.get("result") == "succeeded",
                "Candidate activation is incomplete or belongs to another operation")
        else:
            require(current == self.paths.release(previous)
                and status.get("observedRelease") == previous and status.get("result") == "succeeded"
                and status.get("desiredRelease") == previous, "Active release changed or another operation is pending")
        manifest = json.loads(read_regular(current / "release-manifest.json"))
        require(manifest["configRevision"] == approval.config_revision, "Candidate changes runtime configuration")
        require(not (self.paths.inbox / "request.json").exists() and not (self.paths.inbox / "request.json").is_symlink(),
            "A signed release request is already pending")
        return already_active

    @staticmethod
    def owned_status(status: dict, approval: Approval) -> bool:
        return status.get("operationId") == approval.manifest_digest and status.get("desiredRelease") == approval.commit

    def publish(self, payload: bytes) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix=".voicevox-fix-", dir=self.paths.inbox)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            # A hard link would briefly have nlink=2, which the trusted activator rejects.
            # Linux renameat2 publishes a complete single-link file without overwriting a request.
            rename = ctypes.CDLL(None, use_errno=True).renameat2
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
            target = self.paths.inbox / "request.json"
            if rename(-100, os.fsencode(temporary), -100, os.fsencode(target), 1) != 0:
                code = ctypes.get_errno()
                raise OSError(code, os.strerror(code))
        finally:
            Path(temporary).unlink(missing_ok=True)

    def wait_activation(self, approval: Approval) -> None:
        deadline = self.system.now() + 420
        while self.system.now() < deadline:
            status = self.status()
            if self.owned_status(status, approval):
                if status.get("result") == "failed":
                    raise DeploymentError("Release activator failed: " + str(status.get("reason")))
                if status.get("result") == "succeeded" and status.get("observedRelease") == approval.commit:
                    require(self.current() == self.paths.release(approval.commit), "Active release changed after activation")
                    return
            elif status.get("result") == "running":
                raise DeploymentError("Another release operation started")
            self.system.sleep(1)
        raise DeploymentError("Release activation timed out")

    def json_request(self, base: str, path: str) -> dict:
        status, _, payload = self.system.request(base, path)
        require(status == 200, "Health endpoint failed")
        return json.loads(payload)

    def wait_provider(self) -> None:
        deadline = self.system.now() + 60
        while self.system.now() < deadline:
            try:
                if self.json_request("http://127.0.0.1:8084", "/health").get("status") == "healthy":
                    return
            except (OSError, ValueError, DeploymentError):
                pass
            self.system.sleep(1)
        raise DeploymentError("VOICEVOX did not become healthy")

    def verify(self, approval: Approval) -> None:
        health = self.json_request("http://127.0.0.1:9810", "/health")
        require(health.get("releaseCommit") == approval.commit and health.get("status") == "ok"
            and health.get("configRevision") == approval.config_revision, "Daemon identity mismatch")
        require(self.json_request("http://127.0.0.1:9810", "/ready").get("status") == "ready", "Daemon is not ready")
        tokens = [shlex.split(line.split("=", 1)[1]) for line in
            read_regular(self.paths.environment).decode().splitlines() if line.startswith("LARM_API_TOKEN=")]
        require(len(tokens) == 1 and len(tokens[0]) == 1 and bool(tokens[0][0]), "API token is missing or ambiguous")
        token = tokens[0][0]
        for base in ("http://127.0.0.1:8084", "http://127.0.0.1:9810"):
            for text, expected_status in (("。", 422), ("動作確認です。", 200)):
                for attempt in range(6):
                    status, headers, payload = self.system.request(base, "/v1/audio/speech",
                        body={"model": "voicevox-core", "input": text, "response_format": "wav"},
                        token=token if base.endswith(":9810") else None)
                    if status not in (429, 503) or attempt == 5:
                        break
                    retry = headers.get("Retry-After", "1")
                    self.system.sleep(min(5, max(1, int(retry))) if retry.isdigit() and len(retry) < 8 else 1)
                require(status == expected_status, f"Speech verification failed: {base}, HTTP {status}")
                if status == 422:
                    require(json.loads(payload).get("error", {}).get("code") == "speech_text_unprocessable"
                        and headers.get("Retry-After") is None, "Incorrect unreadable-text contract")
                else:
                    require(headers.get("Content-Type", "").split(";", 1)[0] == "audio/wav", "Incorrect audio media type")
                    with wave.open(io.BytesIO(payload)) as audio:
                        require(audio.getnframes() > 0 and audio.getnchannels() == 1
                            and audio.getsampwidth() == 2, "Invalid synthesized WAV")
        status = self.status()
        require(self.current() == self.paths.release(approval.commit) and self.owned_status(status, approval)
            and status.get("result") == "succeeded" and status.get("observedRelease") == approval.commit,
            "Release changed during speech verification")

    def recover(self, approval: Approval, previous: str) -> str:
        if self.current() != self.paths.release(approval.commit):
            pending = self.paths.inbox / "request.json"
            status = self.status()
            if (pending.exists() and read_regular(pending) == approval.payload) or (
                self.owned_status(status, approval) and status.get("result") == "running"
            ):
                raise DeploymentError("Activation is still pending; inspect the activator before retrying")
            require(self.current() == self.paths.release(previous), "A different release is active; no rollback requested")
            return "Previous release remains active; no rollback requested."
        require(self.owned_status(self.status(), approval), "Cannot roll back a different release operation")
        require(not self.system.activator_running(), "Activator is still running; let its transaction settle before recovery")
        previous_path = self.system.run(["sudo", "-n", "cat", str(self.paths.state / "previous")])
        require(previous_path == str(self.paths.release(previous)), "Rollback target changed; refusing to restore another release")
        self.system.run(["sudo", "-n", "/usr/local/libexec/larm/rollback-larm-release"])
        require(self.current() == self.paths.release(previous), "Rollback did not restore the expected release")
        self.system.run(["sudo", "-n", "systemctl", "restart", "voicevox-tts.service"])
        self.wait_provider()
        require(self.json_request("http://127.0.0.1:9810", "/health").get("releaseCommit") == previous,
            "Restored daemon identity mismatch")
        return "Previous release and VOICEVOX process restored."

    def apply(self, approval: Approval, previous: str) -> None:
        with open(self.paths.inbox / ".voicevox-apply.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.preflight(approval, previous)
            self.system.authenticate()
            already_active = self.preflight(approval, previous)  # Authentication may take time.
            self.system.run(["systemctl", "is-active", "--quiet", "larm-release-activator.path"])
            submitted = already_active
            try:
                if not already_active:
                    # Cover interruption immediately after the atomic publish as well.
                    submitted = True
                    self.publish(approval.payload)
                    print("Waiting for signed release activation...", flush=True)
                    self.wait_activation(approval)
                require(self.current() == self.paths.release(approval.commit)
                    and self.owned_status(self.status(), approval), "Active release changed before provider restart")
                self.system.run(["sudo", "-n", "systemctl", "restart", "voicevox-tts.service"])
                self.wait_provider()
                self.verify(approval)
            except (Exception, KeyboardInterrupt) as error:
                if submitted:
                    try:
                        handlers = {value: signal.getsignal(value) for value in (signal.SIGINT, signal.SIGTERM)}
                        try:
                            for value in handlers:
                                signal.signal(value, signal.SIG_IGN)
                            recovery = self.recover(approval, previous)
                        finally:
                            for value, handler in handlers.items():
                                signal.signal(value, handler)
                    except Exception as recovery_error:
                        raise DeploymentError(f"{error}; recovery incomplete: {recovery_error}") from None
                    raise DeploymentError(f"{error}; {recovery}") from None
                raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--previous", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    require(not (arguments.apply and arguments.check), "Choose --check or --apply")
    require(os.getuid() != 0, "Run as the release builder user; only fixed service operations use sudo")
    deployment = Deployment()
    approval = deployment.approval(arguments.request)
    deployment.preflight(approval, arguments.previous)
    if not arguments.apply:
        print(f"Signed manifest and preconditions verified for {approval.commit}; live environment unchanged.")
        return 0
    deployment.apply(approval, arguments.previous)
    print(f"Applied and verified {approval.commit}: unreadable input=422, following normal sentence=200.")
    return 0


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("Deployment interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except (DeploymentError, OSError, ValueError, KeyError, TypeError, KeyboardInterrupt) as error:
        print(f"VOICEVOX deployment failed: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
