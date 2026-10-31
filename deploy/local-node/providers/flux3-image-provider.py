#!/usr/bin/env python3
"""Demand-only FLUX 3 Klein; caption expansion finishes before native inference."""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

_spec = importlib.util.spec_from_file_location("larm_native_image", Path(__file__).with_name("qwen-image21-turbo-provider.py"))
native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(native)


def expand_caption(model_path: Path, prompt: str, width: int, height: int) -> str:
    # Keep PyTorch and the 9B model in a separate process so all allocations
    # disappear before sd-server lazily loads the image model.
    command = [sys.executable, "-B", str(Path(__file__).with_name("flux3-prompt-upsampler.py")),
        "--model", str(model_path)]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    payload = json.dumps({"prompt": prompt, "width": width, "height": height}).encode()
    deadline = time.monotonic() + 180
    try:
        while True:
            if native.available_bytes() < 16 * 1024**3:
                raise RuntimeError("prompt expansion stopped at the 16 GiB memory floor")
            if time.monotonic() >= deadline:
                raise RuntimeError("prompt expansion timed out")
            try:
                output, _ = child.communicate(input=payload, timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                payload = None
        if child.returncode != 0 or len(output) > 64 * 1024:
            raise RuntimeError("FLUX prompt expansion failed")
        caption = json.loads(output)["caption"]
        if not isinstance(caption, str) or not 1 <= len(caption.strip()) <= 8192:
            raise RuntimeError("FLUX prompt expansion returned an invalid caption")
        return caption.strip()
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()


class Provider(native.Provider):
    model_name = "flux-3-image-klein"
    steps = 16
    alignment = 16
    # sd.cpp recognizes the FLUX 3 flow-map and applies its own shifted schedule.
    # Never reuse Qwen Turbo's custom sigmas here.
    sigmas = None

    def __init__(self, command: list[str], endpoint: str, artifact_root: Path,
            model_source: str, model_revision: str, upsampler: Path) -> None:
        super().__init__(command, endpoint, artifact_root)
        self.model_source, self.model_revision, self.upsampler = model_source, model_revision, upsampler
        self.accepting = False
        self.consumed = False

    def start(self) -> None:
        # Readiness here means accepting one request, not loaded image weights.
        # Start the native process only after the caption process has exited.
        self.accepting = True

    def ready(self) -> bool:
        return native.Provider.ready(self) if self.child is not None else self.accepting and not self.consumed

    def prepare_prompt(self, prompt: str, width: int, height: int) -> str:
        if self.consumed:
            raise RuntimeError("FLUX worker accepts only one generation before shutdown")
        self.consumed = True
        caption = expand_caption(self.upsampler, prompt, width, height)
        native.Provider.start(self)
        return caption


def engine_command(engine: Path, model: Path, encoder: Path, vae: Path, port: int) -> list[str]:
    return [str(engine), "--diffusion-model", str(model), "--llm", str(encoder), "--vae", str(vae),
        "--diffusion-fa", "--rng", "cpu", "-t", "16", "--cfg-scale", "1", "--steps", "16",
        "--sampling-method", "euler", "--flow-shift", "6.93", "--listen-ip", "127.0.0.1", "--listen-port", str(port)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--port", type=int, default=8094)
    parser.add_argument("--engine-port", type=int, default=8095)
    for field in ("engine", "model", "encoder", "vae", "upsampler", "artifact-root"):
        parser.add_argument(f"--{field}", type=Path, required=True)
    parser.add_argument("--model-source", required=True)
    parser.add_argument("--model-revision", required=True)
    args = parser.parse_args()
    for path in (args.engine, args.model, args.encoder, args.vae):
        if not path.is_absolute() or not path.is_file():
            parser.error("engine and weight files must be existing absolute paths")
    if not args.upsampler.is_absolute() or not (args.upsampler / "system_prompts.json").is_file():
        parser.error("upsampler must be a local model directory with system_prompts.json")
    if not re.fullmatch(r"[a-f0-9]{40}", args.model_revision) or not re.fullmatch(r"[\w.-]+/[\w.-]+", args.model_source):
        parser.error("model source and exact Hugging Face commit revision are required")
    if not args.artifact_root.is_absolute() or not 1 <= args.port <= 65535 or not 1 <= args.engine_port <= 65535 or args.port == args.engine_port:
        parser.error("invalid artifact root or ports")
    args.artifact_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    provider = Provider(engine_command(args.engine, args.model, args.encoder, args.vae, args.engine_port),
        f"http://127.0.0.1:{args.engine_port}", args.artifact_root, args.model_source, args.model_revision, args.upsampler)
    native.Handler.provider = provider
    server = ThreadingHTTPServer((args.host, args.port), native.Handler)
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
