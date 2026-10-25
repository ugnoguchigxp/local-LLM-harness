"""Export measured timing stages as CSV without treating execution as accuracy."""
import argparse
import csv
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if args.evidence.resolve().is_relative_to(Path(__file__).resolve().parents[3]):
        raise ValueError("measurement exports must stay outside the source repository")
    names = ["trial.json", "timing-detail.json", "dense-bfloat16.json", "bfloat16-followup.json"]
    rows = []
    for name in names:
        path = args.evidence / name
        if not path.is_file():
            continue
        run = json.loads(path.read_text())
        for sample in run["cases"]:
            measured = sample.get("measurements", {})
            preprocessing = measured.get("preprocessing", [])
            export = sample.get("export_detail", {})
            row = {"run": path.stem, "case": sample["case"]["id"], "task": sample["case"]["task"],
                   "image": sample["case"]["image"], "backbone_dtype": run["backbone_dtype"],
                   "execution_status": sample["status"], "image_decode_seconds": sample.get("image_decode_exif_rgb_seconds"),
                   "preprocess_first_seconds": preprocessing[0]["seconds"] if preprocessing else None,
                   "generation_seconds": measured.get("generation", {}).get("seconds"),
                   "output_tokens": measured.get("generation", {}).get("output_tokens"),
                   "text_decode_seconds": measured.get("text_decode_seconds"),
                   "mask_decode_including_second_preprocess_seconds": measured.get("mask_decode_total_seconds"),
                   "mask_resize_sigmoid_readback_seconds": sum(measured["mask_resize_sigmoid_readback_seconds"]) if "mask_resize_sigmoid_readback_seconds" in measured else None,
                   "predict_seconds": sample.get("predict_seconds"),
                   "parse_predictions_seconds": sample.get("parse_predictions_seconds"),
                   "render_overlay_seconds": export.get("render_overlay_seconds"),
                   "png_encode_and_write_seconds": sum(x["seconds"] for x in export["image_encode_write"]) if "image_encode_write" in export else None,
                   "export_seconds": sample.get("export_seconds"),
                   "postprocess_parse_and_export_seconds": sample.get("postprocess_parse_and_export_seconds"),
                   "local_total_seconds": sample.get("local_total_seconds"),
                   "cuda_peak_allocated_bytes": sample.get("cuda_peak_allocated_bytes"),
                   "mask_validation": json.dumps(sample.get("mask_validation"), ensure_ascii=False)}
            rows.append(row)
    if not rows:
        raise ValueError("no measured samples")
    with (args.evidence / "timings.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.evidence / "timing-stages.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2)+"\n")
    print(f"Exported {len(rows)} observations; blank fields are unmeasured, not zero.")


if __name__ == "__main__":
    main()
