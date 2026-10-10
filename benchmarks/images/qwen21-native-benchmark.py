#!/usr/bin/env python3
"""Benchmark one local GGUF candidate in a temporary loopback-only sd-server."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import platform
import signal
import subprocess
import time
import urllib.request
from pathlib import Path


def available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("MemAvailable is missing")


def process_rss(pid: int) -> int:
    return int(Path(f"/proc/{pid}/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")


def driver_vram() -> int:
    return sum(int(p.read_text()) for p in Path("/sys/class/drm").glob("card*/device/mem_info_vram_used"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    if available() < 48 * 1024**3:
        raise RuntimeError("insufficient headroom to load a benchmark model")
    command = [
        plan["engine"], "--diffusion-model", plan["modelPath"],
        "--vae", plan["vaePath"], "--llm", plan["encoderPath"],
        "--diffusion-fa", "--rng", "cpu", "-t", "16",
        "--cfg-scale", "1.0", "--steps", str(plan["steps"]),
        "--sampling-method", "euler", "--sigmas", ",".join(map(str, plan["sigmas"])),
        "--listen-ip", "127.0.0.1", "--listen-port", str(plan.get("port", 18291)),
    ]
    if plan.get("vaeOnCpu", True):
        command.append("--vae-on-cpu")
    if plan.get("vaeTiling", False):
        command.extend(["--vae-tiling", "--vae-tile-size", str(plan.get("vaeTileSize", "512x512"))])
    if plan.get("visionPath"):
        command.extend(["--llm_vision", plan["visionPath"]])
    endpoint = f'http://127.0.0.1:{plan.get("port", 18291)}'

    def request(path, payload=None):
        req = urllib.request.Request(
            endpoint + path, data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    try:
        request("/v1/models")
    except OSError:
        pass
    else:
        raise RuntimeError("benchmark port is already occupied")

    environment = {"plan": plan, "command": command, "kernel": platform.release(),
                   "initialAvailableBytes": available(), "initialDriverVramBytes": driver_vram()}
    (args.output / "environment.json").write_text(json.dumps(environment, indent=2))
    from PIL import Image
    import numpy as np

    with (args.output / "server.log").open("w") as log:
        start = time.monotonic()
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        peak_rss = 0
        minimum_available = available()
        peak_driver_vram = driver_vram()

        def sample():
            nonlocal peak_rss, minimum_available, peak_driver_vram
            if child.poll() is not None:
                raise RuntimeError(f"sd-server exited with {child.returncode}")
            if plan.get("abortIfProductionMediaStarts", False):
                live = subprocess.check_output(["systemctl", "show", "larm-image-qwen21.service",
                    "larm-music-ace-step.service", "--property=MainPID"], text=True)
                if any(line.startswith("MainPID=") and line != "MainPID=0" for line in live.splitlines()):
                    raise RuntimeError("isolated benchmark yielded to a production media workload")
            peak_rss = max(peak_rss, process_rss(child.pid))
            minimum_available = min(minimum_available, available())
            peak_driver_vram = max(peak_driver_vram, driver_vram())
            if minimum_available < 16 * 1024**3:
                raise RuntimeError("benchmark stopped at the 16 GiB memory floor")

        try:
            while True:
                sample()
                try:
                    request("/v1/models")
                    break
                except OSError:
                    if time.monotonic() - start > 300:
                        raise RuntimeError("sd-server did not become ready within 300 seconds")
                    time.sleep(0.25)
            load = {"loadSeconds": time.monotonic() - start, "peakRssBytes": peak_rss,
                    "minimumAvailableBytes": minimum_available, "peakDriverVramBytes": peak_driver_vram}
            (args.output / "load.json").write_text(json.dumps(load, indent=2))
            print(json.dumps({"event": "loaded", "candidate": plan["candidate"], **load}), flush=True)
            for case_index, case in enumerate(plan["cases"]):
                print(json.dumps({"event": "start", "candidate": plan["candidate"], "case": case["id"]}), flush=True)
                peak_rss = 0
                minimum_available = available()
                peak_driver_vram = driver_vram()
                payload = {"prompt": case["prompt"], "width": case["width"], "height": case["height"],
                           "seed": case["seed"], "batch_count": 1, "output_format": "png",
                           "preview": "none", "sample_params": {
                               "sample_method": "euler", "sample_steps": plan["steps"],
                               "custom_sigmas": plan["sigmas"], "guidance": {"txt_cfg": 1.0}}}
                if case.get("reference"):
                    payload["ref_images"] = [base64.b64encode(Path(case["reference"]).read_bytes()).decode()]
                started = time.monotonic()
                job = request("/sdcpp/v1/img_gen", payload)
                while True:
                    sample()
                    result = request(job["poll_url"])
                    if result["status"] in ("completed", "failed", "cancelled"):
                        break
                    if time.monotonic() - started > 900:
                        raise RuntimeError("generation exceeded 900 seconds")
                    time.sleep(0.2)
                if result["status"] != "completed":
                    raise RuntimeError(str(result.get("error", result["status"])))
                # The async response includes transport and at most 200 ms of polling delay.
                inference_seconds = time.monotonic() - started
                data = base64.b64decode(result["result"]["images"][0]["b64_json"])
                image = Image.open(io.BytesIO(data))
                image.load()
                if image.size != (case["width"], case["height"]):
                    raise RuntimeError("generated image has unexpected dimensions")
                target = args.output / (case["id"] + ".png")
                target.write_bytes(data)
                image.save(args.output / (case["id"] + ".webp"), format="WEBP", quality=80)
                pixels = np.asarray(image.convert("RGB"))
                if pixels.std() < 1:
                    raise RuntimeError("generated image is nearly uniform")
                record = {"candidate": plan["candidate"], **case, "status": "succeeded",
                          "inferenceSeconds": inference_seconds, "totalSeconds": time.monotonic() - started,
                          "peakRssBytes": peak_rss, "minimumAvailableBytes": minimum_available,
                          "peakDriverVramBytes": peak_driver_vram, "png": str(target),
                          "sha256": hashlib.sha256(data).hexdigest(), "pixelStd": float(pixels.std()),
                          "imageMode": image.mode, "actualSize": list(image.size)}
                if case_index == 0:
                    record["coldFirstGenerationSeconds"] = load["loadSeconds"] + record["totalSeconds"]
                with (args.output / "results.jsonl").open("a") as file:
                    file.write(json.dumps(record, ensure_ascii=False) + "\n")
                print(json.dumps(record, ensure_ascii=False), flush=True)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()


if __name__ == "__main__":
    main()
