"""Serial, offline GPU trial of the pinned upstream engine on inspected images.

The upstream engine remains unmodified. Small call wrappers collect synchronized
timings without replacing its preprocessing, generation or decoder algorithms.
"""
import argparse
import faulthandler
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import traceback


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def iou(a, b):
    area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - area
    return area / union if union > 0 else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("cases.json"))
    parser.add_argument("--only", nargs="*")
    parser.add_argument("--output-name", default="trial")
    parser.add_argument("--max-pixels", type=int, default=1960*32*32)
    parser.add_argument("--trace-after", type=int, default=120)
    parser.add_argument("--dtype", choices=["float16", "bfloat16", "float32"], default="float16")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if args.evidence.resolve().is_relative_to(repository):
        raise ValueError("evidence must stay outside the source repository")
    args.evidence.mkdir(parents=True, exist_ok=True)
    faulthandler.dump_traceback_later(args.trace_after, repeat=True)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
    sys.path.insert(0, str(args.source.resolve()))
    import torch
    import numpy as np
    from PIL import Image, ImageOps
    from wevisone_vl import WeVisOneVL
    from wevisone_vl import visualization
    from wevisone_vl.visualization import parse_predictions, save_result

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    if not torch.cuda.is_available() or not torch.version.hip:
        raise RuntimeError("ROCm GPU is required; CPU fallback is forbidden")
    properties = torch.cuda.get_device_properties(0)
    if not properties.gcnArchName.startswith("gfx1151"):
        raise RuntimeError("unexpected architecture: " + properties.gcnArchName)
    expected = json.loads(Path(__file__).with_name("models.json").read_text())
    source_revision = subprocess.check_output(["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True).strip()
    if source_revision != expected["source_revision"]:
        raise ValueError("upstream source revision mismatch")
    receipt = json.loads((args.evidence.parent / "wevisone-vl-research-20261025" / "model-receipt.json").read_text())
    if receipt["revision"] != expected["revision"] or args.model.resolve() != Path(receipt["directory"]).resolve():
        raise ValueError("model receipt mismatch")
    for item in receipt["files"]:
        with (args.model / item["path"]).open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                raise ValueError("model checksum mismatch: " + item["path"])

    class MeasuredEngine(WeVisOneVL):
        def _inputs(self, *positional, **keywords):
            torch.cuda.synchronize()
            start = time.perf_counter()
            inputs = super()._inputs(*positional, **keywords)
            torch.cuda.synchronize()
            metric = {"seconds": time.perf_counter()-start,
                      "tokens": int(inputs["input_ids"].shape[1]),
                      "image_grid_thw": inputs["image_grid_thw"].tolist(),
                      "pixel_values_dtype": str(inputs["pixel_values"].dtype),
                      "pixel_values_device": str(inputs["pixel_values"].device)}
            self.measurements.setdefault("preprocessing", []).append(metric)
            return inputs

        def decode_masks(self, *positional, **keywords):
            torch.cuda.synchronize()
            start = time.perf_counter()
            result = super().decode_masks(*positional, **keywords)
            torch.cuda.synchronize()
            self.measurements["mask_decode_total_seconds"] = time.perf_counter()-start
            return result

        def _masks_from_logits(self, *positional, **keywords):
            torch.cuda.synchronize()
            start = time.perf_counter()
            logits = positional[0] if positional else keywords["logits"]
            self.measurements.setdefault("mask_logits", []).append({
                "finite": bool(torch.isfinite(logits).all().item()),
                "min": float(logits.min().item()) if torch.isfinite(logits).all() else None,
                "max": float(logits.max().item()) if torch.isfinite(logits).all() else None})
            result = super()._masks_from_logits(*positional, **keywords)
            torch.cuda.synchronize()
            self.measurements.setdefault("mask_resize_sigmoid_readback_seconds", []).append(time.perf_counter()-start)
            return result

    metadata = {"model": expected, "source_revision": source_revision, "python": sys.version,
                "torch": torch.__version__, "hip": torch.version.hip,
                "gpu": properties.name, "architecture": properties.gcnArchName,
                "max_pixels": args.max_pixels, "temperature": 0, "concurrency": 1,
                "environment": {key: os.environ.get(key) for key in (
                    "MIOPEN_FIND_MODE", "TORCH_BLAS_PREFER_HIPBLASLT",
                    "TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL")},
                "sampling_note": "Exploratory single calls; no dedicated warm-up; not P50/P95 estimates.",
                "cases": []}
    torch.cuda.synchronize()
    start = time.perf_counter()
    engine = MeasuredEngine(str(args.model), backend="transformers", device="cuda:0",
                            dtype=args.dtype, attention_implementation="sdpa",
                            max_pixels=args.max_pixels, decoder_batch_size=1)
    torch.cuda.synchronize()
    metadata["load_seconds"] = time.perf_counter()-start
    parameter = next(engine.model.parameters())
    if parameter.device.type != "cuda":
        raise RuntimeError("model was not loaded on GPU")
    metadata["backbone_dtype"] = str(parameter.dtype)
    metadata["backbone_device"] = str(parameter.device)
    generate = engine.model.generate

    def measured_generate(*positional, **keywords):
        torch.cuda.synchronize()
        print(json.dumps({"event": "generation_started", "input_tokens": int(keywords["input_ids"].shape[1])}), flush=True)
        start = time.perf_counter()
        output = generate(*positional, **keywords)
        torch.cuda.synchronize()
        count = int(output.shape[1] - keywords["input_ids"].shape[1])
        engine.measurements["generation"] = {"seconds": time.perf_counter()-start,
                                             "output_tokens": count,
                                             "hit_token_limit": count >= keywords.get("max_new_tokens", 0)}
        return output

    engine.model.generate = measured_generate
    batch_decode = engine.processor.batch_decode

    def measured_batch_decode(*positional, **keywords):
        torch.cuda.synchronize()
        start = time.perf_counter()
        output = batch_decode(*positional, **keywords)
        engine.measurements["text_decode_seconds"] = time.perf_counter()-start
        return output

    engine.processor.batch_decode = measured_batch_decode
    print(json.dumps({"event": "loaded", **{k:v for k,v in metadata.items() if k != "cases"}}, ensure_ascii=False), flush=True)
    cases = json.loads(args.cases.read_text())["cases"]
    for case in cases:
        if args.only and case["id"] not in args.only:
            continue
        row = {"case": case, "run": args.output_name}
        engine.measurements = {}
        output = args.evidence / "results" / args.output_name / case["id"]
        output.mkdir(parents=True, exist_ok=True)
        try:
            request_start = time.perf_counter()
            image_path = args.evidence / "images" / case["image"]
            with Image.open(image_path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
            row["image_decode_exif_rgb_seconds"] = time.perf_counter()-request_start
            row["image_sha256"] = hashlib.sha256(image_path.read_bytes()).hexdigest()
            row["image_size"] = list(image.size)
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            start = time.perf_counter()
            result = engine.predict(image, task=case["task"], query=case["query"],
                                    max_new_tokens=case.get("max_new_tokens", 160), temperature=0.0)
            torch.cuda.synchronize()
            row["predict_seconds"] = time.perf_counter()-start
            row["upstream_latency_seconds"] = result.latency_s
            row["response"] = result.response
            row["prompt"] = result.prompt
            row["measurements"] = engine.measurements
            row["backbone_dtype"] = str(next(engine.model.parameters()).dtype)
            row["decoder_dtype"] = str(next(engine.mask_decoder.parameters()).dtype)
            row["cuda_allocated_bytes"] = torch.cuda.memory_allocated()
            row["cuda_peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            row["cuda_peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
            row["process_peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            start = time.perf_counter()
            predictions = parse_predictions(result.response, image.width, image.height)
            row["parse_predictions_seconds"] = time.perf_counter()-start
            row["predictions"] = predictions
            boxes = [annotation["coords"] for annotations in predictions.values()
                     for annotation in annotations if annotation["type"] == "box"]
            row["box_count"] = len(boxes)
            row["mask_count"] = len(result.masks)
            row["mask_shapes"] = [list(mask.shape) for mask in result.masks]
            row["mask_validation"] = [{"finite": bool(np.isfinite(mask).all()),
                                       "min": float(mask.min()) if np.isfinite(mask).all() else None,
                                       "max": float(mask.max()) if np.isfinite(mask).all() else None,
                                       "foreground_pixels_at_0_5": int((mask >= 0.5).sum())}
                                      for mask in result.masks]
            if "expected_boxes" in case:
                targets = case["expected_boxes"]
                row["approximate_target_max_iou"] = [max((iou(box, target) for box in boxes), default=0) for target in targets]
                row["absent_empty"] = not boxes if not targets else None
            if "expected_count" in case:
                row["count_box_exact"] = len(boxes) == case["expected_count"]
            render = visualization.render_overlay
            image_save = Image.Image.save
            export_detail = {"image_encode_write": [], "render_calls": []}

            def timed_render(*positional, **keywords):
                start = time.perf_counter()
                result = render(*positional, **keywords)
                seconds = time.perf_counter()-start
                export_detail["render_calls"].append({"seconds": seconds, "mask_threshold": keywords.get("mask_threshold")})
                export_detail["render_overlay_seconds"] = export_detail.get("render_overlay_seconds", 0) + seconds
                return result

            def timed_save(pil_image, file, *positional, **keywords):
                start = time.perf_counter()
                result = image_save(pil_image, file, *positional, **keywords)
                export_detail["image_encode_write"].append({"file": str(file), "seconds": time.perf_counter()-start})
                return result

            start = time.perf_counter()
            visualization.render_overlay = timed_render
            Image.Image.save = timed_save
            try:
                row["artifacts"] = {key:str(value.relative_to(args.evidence))
                                    for key,value in save_result(output, image, result).items()}
                if case["task"] == "segmentation" and result.masks:
                    binary_overlay = output / "binary-overlay.png"
                    visualization.render_overlay(image, result, mask_threshold=0.5).save(binary_overlay)
                    row["artifacts"]["binary_overlay"] = str(binary_overlay.relative_to(args.evidence))
                    row["binary_mask_files"] = []
                    for index, mask in enumerate(result.masks):
                        mask_file = output / "masks" / f"binary_{index:03d}.png"
                        Image.fromarray(np.uint8(mask >= 0.5)*255).save(mask_file)
                        row["binary_mask_files"].append(str(mask_file.relative_to(args.evidence)))
                    row["segmentation_threshold"] = 0.5
            finally:
                visualization.render_overlay = render
                Image.Image.save = image_save
            row["export_seconds"] = time.perf_counter()-start
            row["export_detail"] = export_detail
            row["postprocess_parse_and_export_seconds"] = row["parse_predictions_seconds"] + row["export_seconds"]
            row["local_total_seconds"] = time.perf_counter()-request_start
            row["status"] = "ok"
        except Exception:
            row["status"] = "error"
            row["traceback"] = traceback.format_exc()
        dump(output / "measurement.json", row)
        metadata["cases"].append(row)
        dump(args.evidence / (args.output_name + ".json"), metadata)
        print(json.dumps({"event": "case", "id": case["id"], "status": row["status"],
                          "seconds": row.get("predict_seconds"), "response": row.get("response"),
                          "traceback": row.get("traceback")}, ensure_ascii=False), flush=True)
    del engine
    torch.cuda.empty_cache()
    faulthandler.cancel_dump_traceback_later()
    print(json.dumps({"event": "complete", "cases": len(metadata["cases"])}), flush=True)


if __name__ == "__main__":
    main()
