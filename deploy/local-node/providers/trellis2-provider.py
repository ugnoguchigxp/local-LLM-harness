#!/usr/bin/env python3
"""Loopback-only, single-job TRELLIS CLI adapter. No weight loading at readiness."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

Image.MAX_IMAGE_PIXELS = 4096 * 4096
ENGINE_COMMIT = "c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f"
WEIGHTS_REVISION = "a57397bd3d351599d9729fc144b3f87c3f87d65b"
FILES = ("dinov3.gguf", "ss_flow.gguf", "ss_dec.gguf", "shape_flow_512.gguf", "shape_dec.gguf", "tex_flow_512.gguf", "tex_dec.gguf", "birefnet.gguf")


def validate_image(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 20 * 1024**2:
        raise ValueError("invalid source image")
    with Image.open(path) as image:
        if image.format not in ("PNG", "WEBP") or min(image.size) < 32 or max(image.size) > 4096:
            raise ValueError("unsupported source image")
        image.verify()


def native_source(source, work):
    # The native stb decoder does not accept WebP. Keep the saved/pinned source
    # byte-for-byte and expand decoded pixels to a private, lossless PNG only
    # for the native engine. This never recompresses the saved WebP.
    with Image.open(source) as image:
        if image.format != "WEBP":
            return source
        image.load()
        mode = "RGBA" if "A" in image.getbands() else "RGB"
        image = image.convert(mode)
        clean = Image.frombytes(mode, image.size, image.tobytes())
        target = work / "native-source.png"
        with open(target, "xb") as output:
            clean.save(output, format="PNG")
        return target


def available_memory():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("memory telemetry unavailable")


class Adapter:
    def __init__(self, engine, models, root):
        self.engine, self.models, self.root = engine, models, root
        self.lock = threading.Lock()
        self.state = {"stage": "idle"}
        self.child = None
        self.closing = False
        if not engine.is_file() or not os.access(engine, os.X_OK):
            raise ValueError("engine unavailable")
        manifest_bytes = (models / "manifest.json").read_bytes()
        if hashlib.sha256(manifest_bytes).hexdigest() != "f13de62be0b5514e3fe9ff3c9c0a4859894f9b086d81c0e6678445b07c2d313f":
            raise ValueError("model manifest hash mismatch")
        manifest = json.loads(manifest_bytes)
        if manifest.get("revision") != WEIGHTS_REVISION:
            raise ValueError("wrong weights revision")
        entries = {entry["file"]: entry for entry in manifest["files"]}
        # Exact hashes are checked by the installer; readiness checks pinned manifest and sizes.
        for name in FILES:
            path = models / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size != entries[name]["bytes"]:
                raise ValueError("model unavailable")
        if not manifest or root.resolve() != root or not (root / "work").is_dir():
            raise ValueError("storage unavailable")

    def run(self, args, work):
        env = dict(os.environ, TMPDIR=str(work / "tmp"))
        with open(work / "worker.log", "ab") as log:
            if self.closing:
                raise RuntimeError("adapter shutting down")
            child = subprocess.Popen([str(self.engine), *args], stdout=log, stderr=subprocess.STDOUT, env=env, cwd=work, start_new_session=True)
            self.child = child
            try:
                if self.closing:
                    raise RuntimeError("adapter shutting down")
                deadline = time.monotonic() + 1800
                while child.poll() is None:
                    if self.closing:
                        raise RuntimeError("adapter shutting down")
                    if available_memory() < 16 * 1024**3:
                        raise RuntimeError("memory floor reached")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("generation timed out")
                    total = sum(p.stat().st_size for p in work.rglob("*") if p.is_file())
                    if total > 20 * 1024**3:
                        raise RuntimeError("work quota exceeded")
                    time.sleep(0.5)
                if child.returncode != 0:
                    raise RuntimeError("native generation failed")
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                self.child = None

    def generate(self, job_id, seed):
        if not re.fullmatch(r"meshjob_[a-f0-9]{32}", job_id) or type(seed) is not int or not 1 <= seed <= 2147483647:
            raise ValueError("invalid job")
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("worker busy")
        try:
            work = self.root / "work" / job_id
            if work.resolve() != work or not work.is_dir():
                raise ValueError("unsafe work path")
            source = work / "source.image"
            validate_image(source)
            input_image = native_source(source, work)
            (work / "tmp").mkdir(mode=0o700, exist_ok=True)
            # Force BiRefNet even if an alpha channel is almost entirely opaque.
            self.state = {"jobId": job_id, "stage": "background"}
            self.run([str(input_image), str(work / "background.glb"), "--models", str(self.models), "--backend", "Vulkan", "--gpu", "0", "--require-gpu", "--bg-removal", "birefnet", "--bg-only", "--dump-bg", "--res", "512", "--seed", str(seed), "--steps", "12", "--threads", "8"], work)
            (work / "background_cutout.png").rename(work / "cutout.png")
            validate_image(work / "cutout.png")
            self.state = {"jobId": job_id, "stage": "mesh"}
            self.run([str(work / "cutout.png"), str(work / "model.glb"), "--models", str(self.models), "--backend", "Vulkan", "--gpu", "0", "--require-gpu", "--res", "512", "--seed", str(seed), "--steps", "12", "--threads", "8"], work)
            output = work / "model.glb"
            if output.is_symlink() or not output.is_file() or not 28 <= output.stat().st_size <= 256 * 1024**2:
                raise ValueError("invalid generated model")
            for path in (source, work / "cutout.png", output):
                with open(path, "rb") as f:
                    os.fsync(f.fileno())
            self.state = {"jobId": job_id, "stage": "ready_to_save"}
        finally:
            self.lock.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8093)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    args = parser.parse_args()
    adapter = Adapter(args.engine, args.models, args.artifact_root)

    def stop(_signal, _frame):
        adapter.closing = True
        child = adapter.child
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            except ProcessLookupError:
                pass
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    class Handler(BaseHTTPRequestHandler):
        def send(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == "/health":
                self.send(200, {"ready": True})
            elif self.path == "/status":
                self.send(200, adapter.state)
            else:
                self.send(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/generate":
                return self.send(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError("invalid body")
                data = json.loads(self.rfile.read(length))
                if set(data) != {"jobId", "seed"}:
                    raise ValueError("invalid body")
                adapter.generate(data["jobId"], data["seed"])
                self.send(200, {"saved": True})
            except Exception as error:
                print(f"generation failed: {type(error).__name__}: {error}", flush=True)
                self.send(503, {"error": "generation_failed"})

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
