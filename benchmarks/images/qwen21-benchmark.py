#!/usr/bin/env python3
"""Measure a local QwenImage21 pipeline without changing LARM services.

Run in an isolated ROCm environment. Plans, model weights, logs and images belong
outside the source repository. Each invocation loads exactly one candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import threading
import time
from pathlib import Path

PROCESS_START = time.monotonic()


def memory_available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("MemAvailable is missing")


def rss() -> int:
    return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")


class MemorySampler:
    def __init__(self) -> None:
        self.peak_rss = rss()
        self.minimum_available = memory_available()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self) -> None:
        while not self.done.wait(0.2):
            self.peak_rss = max(self.peak_rss, rss())
            self.minimum_available = min(self.minimum_available, memory_available())

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.done.set()
        self.thread.join()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    if memory_available() < plan.get("minimumStartAvailableGiB", 48) * 1024**3:
        raise RuntimeError("insufficient headroom to load a benchmark model")

    if plan.get("experimentalFlashAttention"):
        os.environ["TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL"] = "1"

    import numpy as np
    import torch
    import diffusers
    import transformers
    from PIL import Image
    from diffusers import QwenImage21Pipeline, FlowMatchEulerDiscreteScheduler

    torch.set_num_threads(plan.get("cpuThreads", 16))
    torch.set_num_interop_threads(4)
    environment = {
        "plan": plan, "kernel": platform.release(), "torch": torch.__version__,
        "rocm": torch.version.hip, "diffusers": diffusers.__version__,
        "transformers": transformers.__version__, "gpu": torch.cuda.get_device_name(0),
        "initialAvailableBytes": memory_available(), "vae": "CPU FP32", "cfg": 1,
        "experimentalFlashAttention": plan.get("experimentalFlashAttention", False),
        "python": platform.python_version(),
        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    (args.output / "environment.json").write_text(json.dumps(environment, indent=2))
    started = time.monotonic()
    with MemorySampler() as load_memory:
        pipeline = QwenImage21Pipeline.from_pretrained(
            plan["modelPath"], dtype=torch.bfloat16, local_files_only=True
        )
        if plan.get("adapterPath"):
            pipeline.load_lora_weights(
                str(Path(plan["adapterPath"]).parent),
                weight_name=Path(plan["adapterPath"]).name,
            )
            pipeline.scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(
                plan["schedulerPath"], local_files_only=True
            )
        # Avoid putting the VAE on the GPU even temporarily: gfx1151's previous
        # ROCm convolution path produced invalid decoded images on this host.
        pipeline.text_encoder.to("cuda")
        pipeline.transformer.to("cuda")
        pipeline.vae.to(device="cpu", dtype=torch.float32)
        torch.cuda.synchronize()
    load = {
        "loadSeconds": time.monotonic() - started,
        "peakRssBytes": load_memory.peak_rss,
        "minimumAvailableBytes": load_memory.minimum_available,
        "gpuAllocatedBytes": torch.cuda.memory_allocated(),
        "sampleSigmas": pipeline.config.sample_sigmas,
        "adapterParameterCount": sum(
            parameter.numel() for name, parameter in pipeline.transformer.named_parameters()
            if "lora_" in name
        ),
    }
    if plan.get("adapterPath") and load["adapterParameterCount"] == 0:
        raise RuntimeError("adapter loaded without any LoRA parameters")
    (args.output / "load.json").write_text(json.dumps(load, indent=2))
    print(json.dumps({"event": "loaded", "candidate": plan["candidate"], **load}), flush=True)
    pipeline.set_progress_bar_config(disable=True)

    stages: dict[str, float] = {}
    encode_prompt = pipeline.encode_prompt
    encode_vae = pipeline._encode_vae_image

    def timed_prompt(*a, **kw):
        torch.cuda.synchronize()
        start = time.monotonic()
        result = encode_prompt(*a, **kw)
        torch.cuda.synchronize()
        stages["promptEncodeSeconds"] = time.monotonic() - start
        return result

    def cpu_encode(image, generator):
        original_device, original_dtype = image.device, image.dtype
        torch.cuda.synchronize()
        start = time.monotonic()
        result = encode_vae(image.to(device="cpu", dtype=torch.float32), generator)
        result = result.to(device=original_device, dtype=original_dtype)
        torch.cuda.synchronize()
        stages["referenceEncodeSeconds"] = stages.get("referenceEncodeSeconds", 0) + time.monotonic() - start
        if not torch.isfinite(result).all():
            raise RuntimeError("reference VAE encoding is not finite")
        return result

    pipeline.encode_prompt = timed_prompt
    pipeline._encode_vae_image = cpu_encode
    results_path = args.output / "results.jsonl"
    for case_index, case in enumerate(plan["cases"]):
        stages.clear()
        tile_size = case.get("vaeTileSize")
        if tile_size:
            pipeline.vae.enable_tiling(
                tile_sample_min_height=tile_size, tile_sample_min_width=tile_size,
                tile_sample_stride_height=tile_size * 3 // 4,
                tile_sample_stride_width=tile_size * 3 // 4,
            )
        else:
            pipeline.vae.disable_tiling()
        kwargs = {
            "prompt": case["prompt"], "width": case["width"], "height": case["height"],
            "num_inference_steps": plan["steps"], "true_cfg_scale": 1.0,
            "generator": torch.Generator("cpu").manual_seed(case["seed"]),
            "output_type": "latent", "use_kv_cache": True,
        }
        if plan.get("sigmas"):
            kwargs["sigmas"] = plan["sigmas"]
        if case.get("reference"):
            kwargs["image"] = Image.open(case["reference"]).convert("RGBA")
            kwargs["output_resolution"] = case.get("outputResolution", case["width"])
            case["referenceSha256"] = hashlib.sha256(Path(case["reference"]).read_bytes()).hexdigest()
        actual_steps = 0

        def step_end(pipe, i, timestep, callback_kwargs):
            nonlocal actual_steps
            actual_steps += 1
            if actual_steps == 1 or actual_steps % 4 == 0:
                print(json.dumps({"event": "step", "candidate": plan["candidate"],
                                  "case": case["id"], "step": actual_steps}), flush=True)
            if memory_available() < 16 * 1024**3:
                raise RuntimeError("benchmark stopped at the 16 GiB memory floor")
            if time.monotonic() - start > 900:
                raise RuntimeError("generation exceeded 900 seconds")
            return callback_kwargs

        kwargs["callback_on_step_end"] = step_end
        print(json.dumps({"event": "start", "candidate": plan["candidate"], "case": case["id"]}), flush=True)
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
        start = time.monotonic()
        try:
            with MemorySampler() as memory, torch.inference_mode():
                packed = pipeline(**kwargs).images
                torch.cuda.synchronize()
                pipeline_seconds = time.monotonic() - start
                if not torch.isfinite(packed).all():
                    raise RuntimeError("denoised latents are not finite")
                # CPU decode has its own transient buffers, beyond denoising's
                # peak. Admission needs to reserve those before calling VAE.
                decode_reserve_gib = 4 if tile_size else 12 * (case["width"] * case["height"] / 1024**2)
                if memory_available() < (16 + decode_reserve_gib) * 1024**3:
                    raise RuntimeError("insufficient CPU VAE decode headroom")
                decode_start = time.monotonic()
                latents = pipeline._unpack_latents(
                    packed, case["height"], case["width"], pipeline.vae_scale_factor
                ).to(device="cpu", dtype=torch.float32)
                vae = pipeline.vae
                mean = torch.tensor(vae.config.latents_mean).view(1, vae.config.z_dim, 1, 1, 1)
                std = torch.tensor(vae.config.latents_std).view(1, vae.config.z_dim, 1, 1, 1)
                decoded = vae.decode(latents * std + mean, return_dict=False)[0][:, :, 0]
                if not torch.isfinite(decoded).all():
                    raise RuntimeError("VAE output is not finite")
                image = pipeline.image_processor.postprocess(decoded.detach(), output_type="pil")[0]
                decode_seconds = time.monotonic() - decode_start
                inference_seconds = time.monotonic() - start
                target = args.output / (case["id"] + ".png")
                image.save(target, format="PNG")
                # Include a preview alongside lossless benchmark/reference images.
                image.save(args.output / (case["id"] + ".webp"), format="WEBP", quality=80)
                array = np.asarray(image.convert("RGB"))
                record = {
                    "candidate": plan["candidate"], **case, "status": "succeeded",
                    "actualSteps": actual_steps, "pipelineSeconds": pipeline_seconds,
                    **stages, "denoiseSeconds": pipeline_seconds - sum(stages.values()),
                    "decodeSeconds": decode_seconds, "inferenceSeconds": inference_seconds,
                    "totalSeconds": time.monotonic() - start,
                    "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated(),
                    "gpuPeakReservedBytes": torch.cuda.max_memory_reserved(),
                    "peakRssBytes": memory.peak_rss, "minimumAvailableBytes": memory.minimum_available,
                    "png": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "pixelStd": float(array.std()), "imageMode": image.mode,
                    "actualSize": list(image.size),
                }
                if case_index == 0:
                    record["coldFirstGenerationSeconds"] = time.monotonic() - PROCESS_START
        except Exception as error:
            record = {"candidate": plan["candidate"], **case, "status": "failed", "error": str(error)}
        with results_path.open("a") as file:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(json.dumps(record, ensure_ascii=False), flush=True)
        torch.cuda.empty_cache()
        if record["status"] == "failed":
            raise RuntimeError(record["error"])


if __name__ == "__main__":
    main()
