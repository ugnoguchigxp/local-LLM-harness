#!/usr/bin/env python3
"""Loopback-only Qwen-Image 2.1 provider for the local-node image variant."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MODEL_ID = "Qwen/Qwen-Image-2.1"
MODEL_REVISION = "790c92633540aa0cb11d9abf19eb46d861714758"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Provider:
    def __init__(self, model_path: Path, artifact_root: Path) -> None:
        self.model_path = model_path
        self.artifact_root = artifact_root
        self.pipeline: Any | None = None
        self.load_lock = threading.Lock()
        self.generation_lock = threading.Lock()

    def load(self) -> Any:
        with self.load_lock:
            if self.pipeline is not None:
                return self.pipeline
            import torch
            from diffusers import QwenImage21Pipeline

            pipeline = QwenImage21Pipeline.from_pretrained(
                str(self.model_path), dtype=torch.bfloat16, local_files_only=True
            ).to("cuda")
            pipeline.vae.to(device="cpu", dtype=torch.float32)
            self.pipeline = pipeline
            return pipeline

    def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        prompt = request.get("prompt")
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= 8_192:
            raise ValueError("prompt must be a non-empty string of at most 8192 characters")
        width = request.get("width", 512)
        height = request.get("height", 512)
        steps = request.get("steps", 40)
        seed = request.get("seed", 0)
        output_format = request.get("format", "webp")
        if width not in (512, 768, 1024) or height not in (512, 768, 1024):
            raise ValueError("width and height must be 512, 768, or 1024")
        if not isinstance(steps, int) or not 1 <= steps <= 50:
            raise ValueError("steps must be between 1 and 50")
        if not isinstance(seed, int) or not 0 <= seed <= 2**63 - 1:
            raise ValueError("seed must be a non-negative 63-bit integer")
        if output_format not in ("webp", "png"):
            raise ValueError("format must be webp or png")
        if not self.generation_lock.acquire(blocking=False):
            raise RuntimeError("image provider is busy")
        try:
            import torch

            started = time.monotonic()
            pipeline = self.load()
            generator = torch.Generator(device="cpu").manual_seed(seed)
            with torch.inference_mode():
                packed = pipeline(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    generator=generator,
                    output_type="latent",
                ).images
                vae = pipeline.vae
                latents = pipeline._unpack_latents(
                    packed, height, width, pipeline.vae_scale_factor
                ).to(device="cpu", dtype=torch.float32)
                mean = torch.tensor(vae.config.latents_mean).view(1, vae.config.z_dim, 1, 1, 1)
                std = torch.tensor(vae.config.latents_std).view(1, vae.config.z_dim, 1, 1, 1)
                decoded = vae.decode(latents * std + mean, return_dict=False)[0][:, :, 0]
                image = pipeline.image_processor.postprocess(decoded.detach(), output_type="pil")[0]

            artifact_id = f"image_{uuid.uuid4().hex}"
            now = datetime.now(timezone.utc)
            directory = self.artifact_root / now.strftime("%Y") / now.strftime("%m") / artifact_id
            directory.mkdir(parents=True, mode=0o700, exist_ok=False)
            filename = f"image.{output_format}"
            target = directory / filename
            if output_format == "webp":
                image.save(target, format="WEBP", quality=40, method=6)
                mime_type = "image/webp"
            else:
                image.save(target, format="PNG", optimize=True)
                mime_type = "image/png"
            payload = target.read_bytes()
            metadata = {
                "id": artifact_id,
                "createdAt": utc_now(),
                "format": output_format,
                "mimeType": mime_type,
                "file": filename,
                "width": width,
                "height": height,
                "hasAlpha": image.mode in ("RGBA", "LA"),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "model": MODEL_ID,
                "modelRevision": MODEL_REVISION,
                "seed": seed,
                "steps": steps,
            }
            metadata_path = directory / "metadata.json"
            metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) + "\n")
            os.chmod(target, 0o600)
            os.chmod(metadata_path, 0o600)
            return {
                "object": "image_generation",
                "status": "succeeded",
                "artifact": {
                    **{key: value for key, value in metadata.items() if key != "file"},
                    "contentUrl": f"/v1/image-artifacts/{artifact_id}/content",
                },
                "durationMs": round((time.monotonic() - started) * 1_000),
            }
        finally:
            self.generation_lock.release()


class Handler(BaseHTTPRequestHandler):
    provider: Provider
    server_version = "larm-qwen-image21/1"

    def do_GET(self) -> None:
        if self.path != "/health":
            self.respond(404, {"error": "not_found"})
            return
        self.respond(200, {
            "status": "ok",
            "model": MODEL_ID,
            "loaded": self.provider.pipeline is not None,
            "busy": self.provider.generation_lock.locked(),
        })

    def do_POST(self) -> None:
        if self.path != "/v1/generations":
            self.respond(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 2 or length > 32 * 1024:
                raise ValueError("request body size is invalid")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("request body must be an object")
            self.respond(200, self.provider.generate(request))
        except ValueError as error:
            self.respond(400, {"error": "invalid_request", "message": str(error)})
        except RuntimeError as error:
            self.respond(409, {"error": "provider_busy", "message": str(error)})
        except Exception as error:  # Provider logs retain the detailed traceback through systemd.
            self.log_error("generation failed: %s", error)
            self.respond(500, {"error": "generation_failed", "message": "image generation failed"})

    def respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1"):
        raise SystemExit("the image provider must bind to loopback")
    if not args.model.is_dir() or not args.model.is_absolute() or not args.artifact_root.is_absolute():
        raise SystemExit("model and artifact root must be absolute directories")
    args.artifact_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    Handler.provider = Provider(args.model, args.artifact_root)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
