#!/usr/bin/env python3
"""Standalone LTX-Video trial. Engines, weights and results stay outside this repo."""
import argparse
import gc
import importlib.metadata
import json
import os
from fractions import Fraction
from pathlib import Path
import subprocess
import threading
import time

os.environ.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import av
import numpy as np
from PIL import Image, ImageDraw
import psutil
from safetensors import safe_open
import torch
from transformers import T5EncoderModel, T5Tokenizer
from ltx_video.models.autoencoders.causal_video_autoencoder import CausalVideoAutoencoder
from ltx_video.models.autoencoders.vae_encode import vae_decode
from ltx_video.models.transformers.symmetric_patchifier import SymmetricPatchifier
from ltx_video.models.transformers.transformer3d import Transformer3DModel
import ltx_video.pipelines.pipeline_ltx_video as pipeline_module
from ltx_video.pipelines.pipeline_ltx_video import ConditioningItem, LTXVideoPipeline
from ltx_video.schedulers.rf import RectifiedFlowScheduler
from ltx_video.utils.skip_layer_strategy import SkipLayerStrategy


CASES = [
    {
        "id": "01-portrait-still-dance", "title": "Portrait: stillness / explosive dance",
        "base": "A cinematic full body shot of a young adult woman wearing a bright red long coat and black trousers on an empty rooftop at golden hour. Her face and clothing stay consistent. A city skyline is far behind her. Natural realistic photography, clear anatomy, warm sunlight, no text or logos.",
        "segments": [
            "The camera is locked off. She stands completely still, looking calmly toward the camera. Only her breathing and the tips of her hair move very slightly. A long quiet pause, minimal motion.",
            "She suddenly performs a fast energetic spinning dance. Her arms swing outward, her coat flares dramatically and her long hair whips around. The fixed wide camera sees her entire body throughout the rapid movement.",
            "She stops dancing and holds a calm standing pose. Her red coat settles, her arms rest naturally, her face is relaxed. The camera remains completely stationary. Almost no movement.",
            "She suddenly leaps sideways, lands, turns and sweeps both arms in a large powerful dance gesture. Her red coat and hair swing rapidly. Full body visible, energetic movement, fixed camera.",
        ],
    },
    {
        "id": "02-car-stop-drift", "title": "Car: parked / high speed drift",
        "base": "A bright orange sports car on an empty circular test track with wet dark asphalt. Low mountains in the distance under soft overcast daylight. The same orange car remains clearly recognizable. Realistic automotive cinematography, no people, no writing or logos.",
        "segments": [
            "The orange sports car is parked, completely stationary. A wide locked camera shows the car and reflections on the wet asphalt. Almost no motion, quiet and still.",
            "The orange car suddenly accelerates hard and makes a fast sweeping drift around the circular track. Water sprays violently from the rear tires. The camera pans smoothly to keep the rapidly moving car in view.",
            "The orange sports car brakes to a complete stop and rests on the wet track. Spray settles. The camera stops moving. A calm pause with nearly static reflections.",
            "The orange sports car bursts forward again, makes a sharp fast turn and races past the camera. Strong tire spray, rapidly changing reflections, dramatic but physically plausible car movement.",
        ],
    },
    {
        "id": "03-ocean-calm-storm", "title": "Ocean: calm / violent waves",
        "base": "A small dark rocky island with a single white lighthouse in the center of a deep blue ocean. Wide realistic landscape photography from a fixed elevated viewpoint. The lighthouse and island keep their shape and position. Detailed water, natural dramatic light, no text.",
        "segments": [
            "The sea is almost mirror still. The lighthouse stands motionless on its island, reflected in calm blue water. The camera is locked. Only tiny gentle ripples move slowly.",
            "A huge powerful ocean swell rushes toward the island and breaks violently against the rocks. White foam explodes upward, water churns and sprays around the lighthouse. The fixed camera stays stable.",
            "The water settles into a quiet pause. Gentle foam drifts slowly around the island. The lighthouse stays motionless, with only small slow ripples and a static camera.",
            "A second enormous wave rises and crashes against the island from the side. Turbulent blue water and white spray fill the lower frame. The lighthouse remains intact and the camera stays fixed.",
        ],
    },
    {
        "id": "04-architecture-camera", "title": "Architecture: locked camera / fast flythrough",
        "base": "A large futuristic white museum atrium with tall curved arches, a black and white tiled floor, a central red sphere sculpture and wide glass ceilings. Clean architectural photography with natural daylight, strong three dimensional depth, no people or text.",
        "segments": [
            "A completely locked symmetrical wide shot. The red sphere sculpture and white arches remain still. Sunlight is steady. No camera movement, a quiet architectural tableau.",
            "The camera rapidly orbits the central red sphere, moving sideways through the atrium. Strong parallax reveals curved arches behind one another. The architecture and sphere remain rigid and recognizable.",
            "The camera stops and holds its new viewpoint completely still. The red sphere and surrounding white architecture do not move. A long quiet pause, stable geometry and lighting.",
            "The camera accelerates into a fast smooth forward flythrough between the tall white arches and passes close beside the red sphere. Strong perspective changes and parallax, continuous rigid architecture, no cuts.",
        ],
    },
]


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


class TrialPipeline(LTXVideoPipeline):
    @property
    def _execution_device(self):
        # A CPU VAE can coexist with the GPU transformer in this standalone trial.
        return torch.device("cuda")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--encoder", type=Path, required=True)
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=320)
    parser.add_argument("--only", choices=[c["id"] for c in CASES])
    parser.add_argument("--vae", choices=["cpu", "gpu", "compare"], default="cpu")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(16)
    torch.set_num_interop_threads(4)
    torch.set_grad_enabled(False)
    torch.backends.cuda.matmul.allow_tf32 = True
    cases = [c for c in CASES if not args.only or c["id"] == args.only]
    available_floor = 16 * 1024**3
    if psutil.virtual_memory().available < 32 * 1024**3:
        raise RuntimeError("Insufficient available memory to begin this trial")
    started = time.monotonic()
    stop = threading.Event()
    low_memory = threading.Event()

    def monitor():
        proc = psutil.Process()
        with (args.output / "resources.jsonl").open("a") as stream:
            while not stop.is_set():
                memory = psutil.virtual_memory()
                sample = {"elapsedSeconds": time.monotonic() - started,
                          "availableBytes": memory.available, "rssBytes": proc.memory_info().rss,
                          "gpuAllocatedBytes": torch.cuda.memory_allocated(),
                          "gpuReservedBytes": torch.cuda.memory_reserved()}
                stream.write(json.dumps(sample) + "\n")
                stream.flush()
                if memory.available < available_floor:
                    low_memory.set()
                stop.wait(1)

    torch.cuda.init()
    thread = threading.Thread(target=monitor, daemon=True)
    thread.start()
    manifest = {"model": str(args.checkpoint), "encoder": str(args.encoder),
                "width": args.width, "height": args.height, "cases": cases,
                "segmentFrames": [25, 97, 25, 97], "generatedFramesPerVideo": 244,
                "outputFramesPerVideo": 240, "durationSeconds": 20,
                "segmentFrameRates": [4.8, 19.2, 4.8, 19.2],
                "requestedVaeMode": args.vae,
                "promptEnhancement": False, "providerRegistered": False,
                "versions": {n: importlib.metadata.version(n) for n in
                             ["torch", "transformers", "diffusers", "accelerate", "av"]}}
    save_json(args.output / "manifest.json", manifest)

    cache_path = args.output / "prompt-embeddings.pt"
    all_prompts = {f'{c["id"]}/{i}': (c["base"] + " " + text).strip()
                   for c in cases for i, text in enumerate(c["segments"])}
    # Upstream prepares an unconditional embedding even when CFG=1.
    all_prompts["__negative__"] = ""
    if cache_path.exists():
        cache = torch.load(cache_path, map_location="cpu", weights_only=True)
    else:
        cache = {}
    missing = {key: text for key, text in all_prompts.items()
               if key not in cache or cache[key]["prompt"] != text}
    if missing:
        tick = time.monotonic()
        emit("text_encoder_loading")
        tokenizer = T5Tokenizer.from_pretrained(args.encoder, subfolder="tokenizer", local_files_only=True)
        encoder = T5EncoderModel.from_pretrained(
            args.encoder, subfolder="text_encoder", torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True, local_files_only=True).eval().to("cuda")
        emit("text_encoder_loaded", seconds=time.monotonic() - tick)
        for key, text in missing.items():
            if low_memory.is_set():
                raise RuntimeError("Available memory fell below the trial floor")
            inputs = tokenizer(text, padding="max_length", max_length=256,
                               truncation=True, add_special_tokens=True, return_tensors="pt").to("cuda")
            embedding = encoder(**inputs)[0]
            if not bool(embedding.isfinite().all()):
                raise RuntimeError("Non-finite text embedding")
            cache[key] = {"prompt": text, "embedding": embedding.cpu(),
                          "mask": inputs.attention_mask.cpu()}
            emit("text_encoded", key=key)
        torch.save(cache, cache_path)
        del encoder, tokenizer, inputs, embedding
        gc.collect()
        torch.cuda.empty_cache()
        manifest["allTextEncodingSeconds"] = time.monotonic() - tick
        save_json(args.output / "manifest.json", manifest)

    tick = time.monotonic()
    emit("video_models_loading")
    with safe_open(args.checkpoint, framework="pt", device="cpu") as file:
        checkpoint_config = json.loads(file.metadata()["config"])
    allowed = checkpoint_config.get("allowed_inference_steps")
    save_json(args.output / "checkpoint-config.json", checkpoint_config)
    transformer = Transformer3DModel.from_pretrained(args.checkpoint).to(dtype=torch.bfloat16, device="cuda").eval()
    vae = CausalVideoAutoencoder.from_pretrained(args.checkpoint).to(dtype=torch.float32, device="cpu").eval()
    pipeline = TrialPipeline(
        tokenizer=None, text_encoder=None, vae=vae, transformer=transformer,
        scheduler=RectifiedFlowScheduler.from_pretrained(args.checkpoint),
        patchifier=SymmetricPatchifier(patch_size=1),
        prompt_enhancer_image_caption_model=None, prompt_enhancer_image_caption_processor=None,
        prompt_enhancer_llm_model=None, prompt_enhancer_llm_tokenizer=None,
        allowed_inference_steps=allowed)
    original_encode = pipeline_module.vae_encode

    def encode_for_gpu(*positional, **keywords):
        return original_encode(*positional, **keywords).to("cuda")

    pipeline_module.vae_encode = encode_for_gpu
    schedule = [1.0, 0.9937, 0.9875, 0.9812, 0.9750, 0.9094, 0.7250, 0.4219]
    emit("video_models_loaded", seconds=time.monotonic() - tick, allowed=allowed)
    manifest["videoLoadSeconds"] = time.monotonic() - tick
    manifest["timesteps"] = schedule
    save_json(args.output / "manifest.json", manifest)
    vae_mode = "gpu" if args.vae == "gpu" else "cpu"
    compared = args.vae != "compare"

    def decode(latents, mode):
        device = "cuda" if mode == "gpu" else "cpu"
        dtype = torch.bfloat16 if mode == "gpu" else torch.float32
        vae.to(device=device, dtype=dtype)
        noise = torch.randn(latents.shape, generator=torch.Generator().manual_seed(20261020), dtype=torch.float32)
        z = latents.detach().float().cpu() * 0.975 + noise * 0.025
        result = vae_decode(z.to(device=device, dtype=dtype), vae, True,
                            vae_per_channel_normalize=True,
                            timestep=torch.tensor([0.05], device=device, dtype=dtype))
        if not bool(result.isfinite().all()):
            raise RuntimeError(f"Non-finite {mode} VAE output")
        return ((result.float().cpu().clamp(-1, 1) + 1) / 2)[0].permute(1, 2, 3, 0).contiguous()

    try:
        for case in cases:
            directory = args.output / case["id"]
            directory.mkdir(exist_ok=True)
            previous = None
            case_results = []
            for i, frames in enumerate([25, 97, 25, 97]):
                key = f'{case["id"]}/{i}'
                seed = 20261020 + int(case["id"][:2]) * 100 + i
                torch.manual_seed(seed)
                frame_path = directory / f"segment-{i + 1}.npz"
                result_path = directory / f"segment-{i + 1}.json"
                if frame_path.exists() and result_path.exists():
                    pixels = np.load(frame_path)["frames"]
                    previous = pixels[-1]
                    case_results.append(json.loads(result_path.read_text()))
                    emit("segment_reused", key=key)
                    continue
                if low_memory.is_set():
                    raise RuntimeError("Available memory fell below 16 GiB")
                segment_start = time.monotonic()
                emit("segment_start", key=key, frames=frames, seed=seed)
                conditioning = None
                if previous is not None:
                    media = torch.from_numpy(previous.copy()).permute(2, 0, 1).float()[None, :, None] / 127.5 - 1
                    conditioning = [ConditioningItem(media, 0, 1.0)]
                step_times = []

                def callback(pipe, step, timestep, extra):
                    torch.cuda.synchronize()
                    if low_memory.is_set():
                        raise RuntimeError("Available memory fell below 16 GiB")
                    step_times.append(time.monotonic() - segment_start)
                    emit("denoise_step", key=key, step=step + 1,
                         elapsedSeconds=step_times[-1], availableGiB=psutil.virtual_memory().available / 1024**3)

                torch.cuda.reset_peak_memory_stats()
                latent_path = directory / f"segment-{i + 1}-latents.pt"
                latent_meta_path = directory / f"segment-{i + 1}-latents.json"
                resumed = latent_path.exists()
                if latent_path.exists():
                    latent = torch.load(latent_path, map_location="cuda", weights_only=True)
                    emit("latents_reused", key=key)
                else:
                    latent = pipeline(
                        height=args.height, width=args.width, num_frames=frames,
                        frame_rate=(frames - 1) / 5,
                        prompt_embeds=cache[key]["embedding"].to("cuda"),
                        prompt_attention_mask=cache[key]["mask"].to("cuda"),
                        negative_prompt_embeds=cache["__negative__"]["embedding"].to("cuda"),
                        negative_prompt_attention_mask=cache["__negative__"]["mask"].to("cuda"),
                        negative_prompt=None,
                        guidance_scale=1.0, stg_scale=0.0, rescaling_scale=1.0,
                        timesteps=schedule, skip_layer_strategy=SkipLayerStrategy.AttentionValues,
                        generator=torch.Generator(device="cuda").manual_seed(seed),
                        conditioning_items=conditioning, output_type="latent", is_video=True,
                        vae_per_channel_normalize=True, image_cond_noise_scale=0.15,
                        callback_on_step_end=callback, enhance_prompt=False,
                    ).images
                    if not bool(latent.isfinite().all()):
                        raise RuntimeError("Non-finite generated latent")
                    torch.save(latent.cpu(), latent_path)
                torch.cuda.synchronize()
                denoise_seconds = time.monotonic() - segment_start
                denoise_steps = len(step_times)
                if resumed and latent_meta_path.exists():
                    previous_generation = json.loads(latent_meta_path.read_text())
                    denoise_seconds = previous_generation["denoiseSeconds"]
                    denoise_steps = previous_generation["steps"]
                else:
                    save_json(latent_meta_path, {"denoiseSeconds": denoise_seconds, "steps": denoise_steps})
                decode_start = time.monotonic()
                if not compared:
                    cpu = decode(latent, "cpu")
                    comparison = {"cpuDecodeSeconds": time.monotonic() - decode_start}
                    gpu_start = time.monotonic()
                    try:
                        gpu = decode(latent, "gpu")
                        error = float((cpu - gpu).abs().mean())
                        comparison.update(gpuDecodeSeconds=time.monotonic() - gpu_start, meanAbsoluteError=error)
                        vae_mode = "gpu" if error < 0.03 else "cpu"
                        Image.fromarray((gpu[0].numpy() * 255).round().astype("uint8")).save(args.output / "vae-gpu-check.png")
                    except (RuntimeError, torch.OutOfMemoryError) as error:
                        comparison["gpuError"] = str(error)
                        vae_mode = "cpu"
                    comparison["selected"] = vae_mode
                    Image.fromarray((cpu[0].numpy() * 255).round().astype("uint8")).save(args.output / "vae-cpu-check.png")
                    save_json(args.output / "vae-comparison.json", comparison)
                    emit("vae_comparison", **comparison)
                    decoded = gpu if vae_mode == "gpu" else cpu
                    compared = True
                else:
                    try:
                        decoded = decode(latent, vae_mode)
                    except (RuntimeError, torch.OutOfMemoryError) as error:
                        if vae_mode != "gpu":
                            raise
                        emit("vae_cpu_fallback", key=key, reason=str(error))
                        vae_mode = "cpu"
                        decoded = decode(latent, "cpu")
                # The extra endpoint is used to condition the following segment.
                if decoded.shape[0] != frames:
                    raise RuntimeError(f"Unexpected frame count {decoded.shape[0]} != {frames}")
                pixels = (decoded.numpy() * 255).round().astype("uint8")
                differences = np.abs(np.diff(pixels[:, ::4, ::4].astype(np.float32), axis=0))
                np.savez_compressed(frame_path, frames=pixels)
                previous = pixels[-1]
                decode_and_save_seconds = time.monotonic() - decode_start
                result = {"segment": i + 1, "prompt": all_prompts[key], "seed": seed,
                          "generatedFrames": frames, "outputFrames": frames - 1,
                          "durationSeconds": 5, "frameRate": (frames - 1) / 5,
                          "meanPixelDifference": float(differences.mean()),
                          "pixelDifferencePerSecond": float(differences.mean()) * (frames - 1) / 5,
                          "denoiseSeconds": denoise_seconds,
                          "decodeAndSaveSeconds": decode_and_save_seconds,
                          "totalSeconds": denoise_seconds + decode_and_save_seconds,
                          "vae": vae_mode, "steps": denoise_steps, "resumedLatents": resumed,
                          "gpuPeakAllocatedBytes": torch.cuda.max_memory_allocated(),
                          "gpuPeakReservedBytes": torch.cuda.max_memory_reserved()}
                save_json(result_path, result)
                case_results.append(result)
                emit("segment_complete", case=case["id"], **result)
                del decoded, latent
                gc.collect()
                torch.cuda.empty_cache()
                # Return VAE to its selected device for the next image conditioning.
                vae.to(device="cuda" if vae_mode == "gpu" else "cpu",
                       dtype=torch.bfloat16 if vae_mode == "gpu" else torch.float32)
            output = directory / f'{case["id"]}-20s-vfr.mp4'
            encode_video(directory, output, args.width, args.height)
            make_contact_sheet(directory, case)
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-count_frames", "-show_entries",
                "stream=codec_name,width,height,nb_read_frames,avg_frame_rate,r_frame_rate,duration:format=duration",
                "-of", "json", str(output)], text=True))
            stream = probe["streams"][0]
            if int(stream["nb_read_frames"]) > 250 or abs(float(probe["format"]["duration"]) - 20) > 0.01:
                raise RuntimeError(f"Duration/frame budget verification failed: {probe}")
            save_json(directory / "result.json", {"case": case, "segments": case_results,
                      "generationSeconds": sum(r["totalSeconds"] for r in case_results),
                      "video": str(output), "probe": probe})
            emit("video_complete", case=case["id"], video=str(output), probe=probe)
    finally:
        stop.set()
        thread.join(3)


def encode_video(directory, output, width, height):
    time_base = Fraction(1, 19200)
    with av.open(str(output), "w", options={"movflags": "+faststart"}) as container:
        stream = container.add_stream("libx264", rate=Fraction(96, 5))
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.time_base = time_base
        stream.codec_context.time_base = time_base
        stream.options = {"crf": "18", "preset": "medium", "bf": "0"}
        pts, durations = 0, {}
        for i in range(4):
            pixels = np.load(directory / f"segment-{i + 1}.npz")["frames"][:-1]
            duration = 4000 if i % 2 == 0 else 1000
            for picture in pixels:
                frame = av.VideoFrame.from_ndarray(picture, format="rgb24")
                frame.pts, frame.time_base = pts, time_base
                durations[pts] = duration
                for packet in stream.encode(frame):
                    packet.duration = durations[int(packet.pts * packet.time_base / time_base)]
                    container.mux(packet)
                pts += duration
        for packet in stream.encode():
            packet.duration = durations[int(packet.pts * packet.time_base / time_base)]
            container.mux(packet)
        assert pts == 20 * 19200


def make_contact_sheet(directory, case):
    sheet = Image.new("RGB", (512 * 4, 344 * 4), "#171b21")
    draw = ImageDraw.Draw(sheet)
    for i in range(4):
        frames = np.load(directory / f"segment-{i + 1}.npz")["frames"]
        for j, index in enumerate(np.linspace(0, len(frames) - 1, 4).astype(int)):
            image = Image.fromarray(frames[index]).resize((512, 320))
            sheet.paste(image, (j * 512, i * 344 + 24))
            draw.text((j * 512 + 8, i * 344 + 5),
                      f'{i * 5 + index / (len(frames) - 1) * 5:.2f}s  {"STILL" if i % 2 == 0 else "MOTION"}', fill="white")
    sheet.save(directory / "contact-sheet.jpg", quality=90)


if __name__ == "__main__":
    main()
