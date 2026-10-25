"""Download the complete official snapshot, including the separate pixel decoder.

Use a download-only environment with huggingface-hub; this does not import torch
or execute upstream code. All downloaded artifacts and receipts stay external.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def main():
    from huggingface_hub import HfApi, snapshot_download

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[3]
    for directory in (args.root, args.evidence):
        if directory.resolve().is_relative_to(source):
            raise ValueError("models and evidence must be outside the source repository")
        directory.mkdir(parents=True, exist_ok=True)

    spec = json.loads(Path(__file__).with_name("models.json").read_text())
    info = HfApi().model_info(spec["repo"], revision=spec["revision"], files_metadata=True)
    if info.sha != spec["revision"]:
        raise ValueError("unexpected snapshot revision")
    target = args.root / "WeVisOne-VL-4B" / spec["revision"]
    expected_names = {entry.rfilename for entry in info.siblings}
    for required in ("model.safetensors", "mask_decoder.pt", "config.json",
                     "processor_config.json", "tokenizer.json", "LICENSE"):
        if required not in expected_names:
            raise ValueError("upstream snapshot lacks " + required)
    print(json.dumps({"status": "downloading", "repo": spec["repo"],
                      "revision": info.sha, "directory": str(target),
                      "bytes": sum(entry.size or 0 for entry in info.siblings)}), flush=True)
    snapshot_download(spec["repo"], revision=spec["revision"], local_dir=target,
                      max_workers=2)
    files = []
    for entry in info.siblings:
        path = target / entry.rfilename
        if not path.is_file():
            raise ValueError("missing snapshot file: " + entry.rfilename)
        if entry.size is not None and path.stat().st_size != entry.size:
            raise ValueError("size mismatch: " + entry.rfilename)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        expected = entry.lfs.sha256 if entry.lfs else None
        if expected and digest != expected:
            raise ValueError("upstream SHA256 mismatch: " + entry.rfilename)
        files.append({"path": entry.rfilename, "bytes": path.stat().st_size,
                      "sha256": digest, "upstream_lfs_sha256": expected})
        print(json.dumps({"status": "verified", **files[-1]}), flush=True)
    record = {**spec, "directory": str(target), "files": files,
              "verified_at": datetime.now(timezone.utc).isoformat(),
              "total_bytes": sum(item["bytes"] for item in files),
              "inference_executed": False}
    receipt = args.evidence / "model-receipt.json"
    temporary = receipt.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    temporary.replace(receipt)
    print(json.dumps({"status": "complete", "receipt": str(receipt),
                      "total_bytes": record["total_bytes"]}), flush=True)


if __name__ == "__main__":
    main()
