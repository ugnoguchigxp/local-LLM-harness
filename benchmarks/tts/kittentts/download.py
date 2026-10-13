"""Acquire pinned nano weights outside the repository and verify SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

MODELS = {
    "fp32": {
        "revision": "7a1db645b1f3ab9420761d87428e042b9cec3f26",
        "model_sha256": "320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e",
    },
    "int8": {
        "revision": "84781d74e29ee25217551556398b42f80593a813",
        "model_sha256": "f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc",
    },
}
COMMON = {
    "config.json": "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64",
    "voices.npz": "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.output.is_absolute() or args.output.resolve() == repository or repository in args.output.resolve().parents:
        parser.error("Use an absolute model directory outside the source repository")
    rows = []
    for variant, model in MODELS.items():
        root = args.output / variant
        root.mkdir(parents=True, exist_ok=True)
        files = {**COMMON, "kitten_tts_nano_v0_8.onnx": model["model_sha256"]}
        for filename, expected in files.items():
            path = root / filename
            url = f"https://huggingface.co/KittenML/kitten-tts-nano-0.8-{variant}/resolve/{model['revision']}/{filename}"
            if not path.exists():
                temporary = path.with_suffix(path.suffix + ".part")
                urllib.request.urlretrieve(url, temporary)
                if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
                    raise ValueError(f"SHA-256 mismatch: {temporary}")
                temporary.replace(path)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != expected:
                raise ValueError(f"SHA-256 mismatch: {path}")
            row = dict(variant=variant, revision=model["revision"], file=filename,
                       bytes=path.stat().st_size, sha256=digest, url=url)
            rows.append(row)
            print(json.dumps(row), flush=True)
    (args.output / "manifest.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
