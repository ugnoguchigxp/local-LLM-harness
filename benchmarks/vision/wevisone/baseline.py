"""Read-only, direct CPU comparison with the deployed YOLO and OCR engines."""
import argparse
import json
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if args.evidence.resolve().is_relative_to(repository):
        raise ValueError("evidence must stay outside the source repository")
    sys.path[:0] = [str(args.release), str(args.release / "site-packages")]
    from vision_ocr.engines import ObjectEngine, OcrEngine, load_image

    config = {"models": json.loads((args.release / "models/models.json").read_text())}
    output = {"release": str(args.release), "execution": "standalone CPU; shared workers unchanged", "cases": []}
    for kind, cls in (("objects", ObjectEngine), ("ocr", OcrEngine)):
        start = time.perf_counter()
        engine = cls(config)
        output[kind + "_load_seconds"] = time.perf_counter() - start
        for name in ("desk-spill.png", "repair-workbench.png"):
            image = load_image(args.evidence / "images" / name)
            start = time.perf_counter()
            result = engine.infer(image)
            seconds = time.perf_counter() - start
            row = {"image": name, "kind": kind, "seconds": seconds, "result": result}
            output["cases"].append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    (args.evidence / "baseline.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
