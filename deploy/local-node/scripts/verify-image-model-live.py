#!/usr/bin/env python3
"""Submit exactly one image request, verify its saved content and stopped worker."""
import argparse
from datetime import datetime
import hashlib
import io
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def process_identity(pid, proc_root=Path("/proc")):
    try:
        fields = (proc_root / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": int(pid), "parentPid": int(fields[1]), "startTicks": int(fields[19])}
    except (OSError, ValueError, IndexError):
        return None


def process_stopped(identity, proc_root=Path("/proc")):
    current = process_identity(identity["pid"], proc_root)
    return current is None or current["startTicks"] != identity["startTicks"]


def select_request_process(observations, model, created_at):
    created = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
    needle = "flux3imageklein" if model == "flux-3-image-klein" else "qwenimage21turbo"
    candidates = [item for item in observations
        if needle in "".join(c for c in Path(item["modelPath"]).name.lower() if c.isalnum())
        and item["startedAtEpoch"] <= created]
    if not candidates:
        raise RuntimeError("the requested generation's native process was not observed")
    return max(candidates, key=lambda item: item["startedAtEpoch"])


class WorkerObserver:
    def __init__(self, unit):
        self.unit = unit
        self.stop = threading.Event()
        self.observations = {}
        self.boot_epoch = time.time() - time.clock_gettime(time.CLOCK_BOOTTIME)
        self.ticks = os.sysconf("SC_CLK_TCK")
        self.thread = threading.Thread(target=self.observe, daemon=True)

    def observe(self):
        group = None
        while not self.stop.is_set():
            try:
                if group is None:
                    value = subprocess.check_output(["systemctl", "show", self.unit,
                        "--property=ControlGroup", "--value"], text=True, stderr=subprocess.DEVNULL, timeout=1).strip()
                    if value:
                        group = Path("/sys/fs/cgroup") / value.lstrip("/") / "cgroup.procs"
                for pid in group.read_text().split() if group is not None and group.exists() else []:
                    command = (Path("/proc") / pid / "cmdline").read_bytes().decode().split("\0")
                    if not command or Path(command[0]).name != "sd-server" or "--diffusion-model" not in command:
                        continue
                    native = process_identity(pid)
                    worker = process_identity(native["parentPid"]) if native else None
                    if native and worker:
                        self.observations[(native["pid"], native["startTicks"])] = {
                            "native": native, "worker": worker,
                            "modelPath": command[command.index("--diffusion-model") + 1],
                            "startedAtEpoch": self.boot_epoch + native["startTicks"] / self.ticks}
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                pass
            self.stop.wait(0.1)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", choices=["default", "qwen-image-2.1-turbo", "flux-3-image-klein"], required=True)
    parser.add_argument("--size", type=int, default=768)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--credential-file", type=Path)
    parser.add_argument("--unit", default="larm-image-qwen21.service")
    args = parser.parse_args()
    if not 100 <= args.size <= 1280:
        parser.error("size must be between 100 and 1280")
    token = os.environ.get("LARM_API_TOKEN")
    if not token and args.credential_file:
        for line in args.credential_file.read_text().splitlines():
            if line.startswith("LARM_API_TOKEN="):
                token = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not token:
        parser.error("Control credential is required")
    base = args.base_url.rstrip("/")
    origin = urllib.parse.urlsplit(base)
    if origin.scheme not in ("http", "https") or not origin.netloc or origin.username or origin.password:
        parser.error("invalid base URL")
    args.output.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(NoRedirect())
    summary = {"modelRequested": args.model, "size": args.size, "generationPosts": 0, "status": "failed"}
    started = time.monotonic()
    observer = WorkerObserver(args.unit)
    observer.start()

    def request(path, body=None):
        url = urllib.parse.urljoin(base + "/", path)
        target = urllib.parse.urlsplit(url)
        if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
            raise RuntimeError("refusing cross-origin artifact URL")
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        return opener.open(req, timeout=1020)

    try:
        summary["stage"] = "generation"
        payload = {"prompt": "窓辺で眠る猫の写真", "width": args.size, "height": args.size, "seed": 42, "format": "webp"}
        if args.model != "default":
            payload["model"] = args.model
        # Intentionally omit steps. There is no retry loop for generation POST.
        summary["generationPosts"] = 1
        with request("/v1/images/generations", payload) as response:
            summary["httpStatus"] = response.status
            result = json.load(response)
        observer.close()
        (args.output / "response.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        artifact = (result.get("artifacts") or [result["artifact"]])[0]
        expected_steps = 16 if args.model == "flux-3-image-klein" else 8
        expected_source = "leejet/flux-3-image-klein-GGUF" if expected_steps == 16 else "AtomicChat/Qwen-Image-2.1-Turbo-GGUF"
        if artifact.get("model") != expected_source or artifact.get("steps") != expected_steps:
            raise RuntimeError("artifact provenance does not match the requested model")
        summary["artifact"] = artifact
        summary["stage"] = "artifact-get"
        path = artifact["contentUrl"]
        if not path.startswith("/v1/image-artifacts/"):
            raise RuntimeError("invalid artifact URL")
        with request(path) as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if response.headers.get_content_type() != "image/webp":
                raise RuntimeError("artifact HTTP content type is not WebP")
        if len(data) != artifact["bytes"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
            raise RuntimeError("artifact bytes or SHA256 mismatch")
        from PIL import Image
        summary["stage"] = "artifact-decode"
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.size != (args.size, args.size) or image.format != "WEBP":
                raise RuntimeError("decoded artifact dimensions or format mismatch")
            summary["decoded"] = {"width": image.width, "height": image.height, "format": image.format}
        (args.output / "image.webp").write_bytes(data)
        summary["stage"] = "worker-stop"
        state = subprocess.check_output(["systemctl", "show", args.unit,
            "--property=ActiveState,MainPID,ControlGroup"], text=True, timeout=10)
        properties = dict(line.split("=", 1) for line in state.splitlines() if "=" in line)
        summary["worker"] = properties
        own = select_request_process(list(observer.observations.values()), args.model, artifact["createdAt"])
        summary["requestProcesses"] = own
        if not process_stopped(own["native"]) or not process_stopped(own["worker"]):
            raise RuntimeError("the requested generation's worker or native process remains alive")
        summary["requestProcessesStopped"] = True
        # A new request may already own this same unit. Its PID is a different
        # execution, so never stop it or classify it as the prior job leaking.
        summary["otherRequestActive"] = properties.get("MainPID") not in ("0", str(own["worker"]["pid"]))
        summary["stage"] = "saved-artifact-get-after-stop"
        with request(path) as response:
            saved = response.read(32 * 1024 * 1024 + 1)
        if saved != data:
            raise RuntimeError("saved artifact changed after worker shutdown")
        summary.update(status="succeeded", stage="complete", savedAfterStop=True)
    except urllib.error.HTTPError as error:
        summary["httpStatus"] = error.code
        try:
            body = json.loads(error.read(64 * 1024))
            summary["error"] = body.get("error", body)
        except (ValueError, OSError):
            summary["error"] = {"code": "invalid_http_error_body"}
    except Exception as error:
        summary["error"] = {"code": "verification_failed", "message": str(error)}
    finally:
        observer.close()
        summary["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (args.output / "verification.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(summary, ensure_ascii=False))
    if summary["status"] != "succeeded":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
