#!/usr/bin/env python3
"""Demand-only Turbo GGUF provider; Control owns startup and worker shutdown."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import subprocess
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = "qwen-image-2.1-turbo"
MODEL_SOURCE = "AtomicChat/Qwen-Image-2.1-Turbo-GGUF"
MODEL_REVISION = "bb25d06bc74119c12207243d68917951e6d9c232"
SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0]


def available_bytes() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("cannot read available host memory")


class Provider:
    def __init__(self, command: list[str], endpoint: str, artifact_root: Path) -> None:
        self.command, self.endpoint, self.artifact_root = command, endpoint, artifact_root
        self.child: subprocess.Popen | None = None
        self.generation_lock = threading.Lock()

    def request(self, path: str, payload: dict | None = None) -> dict:
        if not path.startswith(("/v1/", "/sdcpp/v1/")) or "?" in path or "#" in path:
            raise RuntimeError("invalid engine response URL")
        req = urllib.request.Request(self.endpoint + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as response:
            encoded = response.read(64 * 1024 * 1024 + 1)
            if len(encoded) > 64 * 1024 * 1024:
                raise RuntimeError("engine response exceeds size limit")
            return json.loads(encoded)

    def start(self) -> None:
        # Never take ownership of an unrelated listener on the private port.
        import errno
        import socket
        from urllib.parse import urlparse
        address = urlparse(self.endpoint)
        with socket.socket() as probe:
            # sd-server uses SO_REUSEPORT on Linux. A REUSEADDR-only probe
            # cannot bind its TIME_WAIT sockets; do not enable REUSEPORT here,
            # since that would also allow sharing an unrelated live listener.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((address.hostname, address.port))
            except OSError as error:
                states = []
                if error.errno == errno.EADDRINUSE:
                    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
                        for line in Path(table).read_text().splitlines()[1:]:
                            fields = line.split()
                            if int(fields[1].rsplit(":", 1)[1], 16) == address.port:
                                states.append(fields[3])
                # Only closed TCP connections may remain; LISTEN, active
                # connections, or an unexplained reservation still fail.
                if not states or any(state != "06" for state in states):
                    raise
        self.child = subprocess.Popen(self.command)
        deadline = time.monotonic() + 30
        while not self.ready():
            if self.child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Turbo engine failed to start")
            time.sleep(0.1)

    def ready(self) -> bool:
        if self.child is None or self.child.poll() is not None:
            return False
        try:
            self.request("/v1/models")
            return True
        except (OSError, ValueError):
            return False

    def close(self) -> None:
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()

    def generate(self, request: dict) -> dict:
        allowed = {"prompt", "model", "width", "height", "steps", "seed", "format"}
        if request.keys() - allowed:
            raise ValueError("unknown image request field")
        prompt = request.get("prompt")
        width, height = request.get("width", 512), request.get("height", 512)
        seed, output_format = request.get("seed", 0), request.get("format", "webp")
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= 8192:
            raise ValueError("prompt must contain 1 to 8192 characters")
        if request.get("model", MODEL) != MODEL:
            raise ValueError("model must match the advertised Turbo service")
        if type(width) is not int or type(height) is not int or not 100 <= width <= 1280 or not 100 <= height <= 1280:
            raise ValueError("width and height must be integers from 100 to 1280")
        if type(request.get("steps", 8)) is not int or request.get("steps", 8) != 8:
            raise ValueError("Turbo uses exactly 8 steps")
        if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
            raise ValueError("seed must be a non-negative safe integer")
        if output_format not in ("webp", "png"):
            raise ValueError("format must be webp or png")
        if not self.generation_lock.acquire(blocking=False):
            raise RuntimeError("image provider is busy")
        try:
            started = time.monotonic()
            # Qwen's native engine requires multiples of 32. Keep the public
            # artifact dimensions exact by resizing after validated generation.
            engine_width, engine_height = ((value + 31) // 32 * 32 for value in (width, height))
            job = self.request("/sdcpp/v1/img_gen", {
                "prompt": prompt, "width": engine_width, "height": engine_height, "seed": seed,
                "batch_count": 1, "output_format": "png", "preview": "none",
                "sample_params": {"sample_method": "euler", "sample_steps": 8,
                    "custom_sigmas": SIGMAS, "guidance": {"txt_cfg": 1.0}},
            })
            while True:
                if self.child is None or self.child.poll() is not None:
                    raise RuntimeError("Turbo engine exited during generation")
                if available_bytes() < 16 * 1024**3:
                    self.close()
                    raise RuntimeError("generation stopped at the 16 GiB memory floor")
                if time.monotonic() - started > 850:
                    self.close()
                    raise RuntimeError("image generation timed out")
                result = self.request(job["poll_url"])
                if result["status"] == "completed":
                    break
                if result["status"] in ("failed", "cancelled"):
                    raise RuntimeError("Turbo generation failed")
                time.sleep(0.2)
            from PIL import Image
            raw = base64.b64decode(result["result"]["images"][0]["b64_json"], validate=True)
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                if source.size != (engine_width, engine_height):
                    raise RuntimeError("engine returned unexpected image dimensions")
                image = source.copy() if source.size == (width, height) else source.resize(
                    (width, height), Image.Resampling.LANCZOS)
            now = datetime.now(timezone.utc)
            artifact_id = f"image_{uuid.uuid4().hex}"
            directory = self.artifact_root / now.strftime("%Y") / now.strftime("%m") / artifact_id
            directory.mkdir(parents=True, mode=0o700, exist_ok=False)
            filename = f"image.{output_format}"
            target = directory / filename
            image.save(target, format=output_format.upper(), **({"quality": 80, "method": 4} if output_format == "webp" else {}))
            payload = target.read_bytes()
            metadata = {
                "id": artifact_id, "createdAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "format": output_format, "mimeType": f"image/{output_format}", "file": filename,
                "width": width, "height": height, "hasAlpha": image.mode in ("RGBA", "LA"),
                "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                "model": MODEL_SOURCE, "modelRevision": MODEL_REVISION, "seed": seed, "steps": 8,
            }
            metadata_path = directory / "metadata.json"
            metadata_path.write_text(json.dumps(metadata, ensure_ascii=False) + "\n")
            os.chmod(target, 0o600)
            os.chmod(metadata_path, 0o600)
            return {"object": "image_generation", "status": "succeeded",
                "artifact": {**{k: v for k, v in metadata.items() if k != "file"},
                    "contentUrl": f"/v1/image-artifacts/{artifact_id}/content"},
                "durationMs": round((time.monotonic() - started) * 1000)}
        finally:
            self.generation_lock.release()


class Handler(BaseHTTPRequestHandler):
    provider: Provider
    server_version = "larm-qwen-image21-turbo/1"

    def respond(self, status: int, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.respond(404, {"error": "not_found"})
        ready = self.provider.ready()
        # sd-server loads weights lazily on the first image; ready means accepting work.
        self.respond(200 if ready else 503, {"ready": ready, "model": MODEL,
            "busy": self.provider.generation_lock.locked()})

    def do_POST(self) -> None:
        if self.path != "/v1/generations":
            return self.respond(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if not 2 <= length <= 32 * 1024:
                raise ValueError("invalid request body size")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("request body must be an object")
            self.respond(200, self.provider.generate(request))
        except ValueError as error:
            self.respond(400, {"error": "invalid_request", "message": str(error)})
        except Exception:
            import traceback
            traceback.print_exc()
            self.respond(503, {"error": "generation_failed", "message": "image generation failed"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--engine-port", type=int, default=8092)
    for field in ("engine", "model", "encoder", "vae", "artifact-root"):
        parser.add_argument(f"--{field}", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.engine, args.model, args.encoder, args.vae):
        if not path.is_absolute() or not path.is_file():
            parser.error("engine and weight files must be existing absolute paths")
    if not args.artifact_root.is_absolute() or not 1 <= args.port <= 65535 or not 1 <= args.engine_port <= 65535 or args.port == args.engine_port:
        parser.error("invalid artifact root or ports")
    args.artifact_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    command = [str(args.engine), "--diffusion-model", str(args.model), "--llm", str(args.encoder),
        "--vae", str(args.vae), "--diffusion-fa", "--rng", "cpu", "-t", "16",
        "--cfg-scale", "1", "--steps", "8", "--sampling-method", "euler",
        "--sigmas", ",".join(map(str, SIGMAS)), "--listen-ip", "127.0.0.1",
        "--listen-port", str(args.engine_port)]
    provider = Provider(command, f"http://127.0.0.1:{args.engine_port}", args.artifact_root)
    Handler.provider = provider
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        provider.start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        provider.close()


if __name__ == "__main__":
    main()
