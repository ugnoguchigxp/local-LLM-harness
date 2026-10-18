#!/usr/bin/env python3
"""Verify already acquired assets and prepare durable storage; never download weights."""
import hashlib
import json
from pathlib import Path
import shutil
import os

ROOT = Path("/srv/ai/data/generated/3d")
ENGINE = Path("/srv/ai/apps/trellis-cpp-v0.8.1-vulkan")
MODELS = Path("/srv/ai/models/trellis2-gguf-a57397bd")
VIEWER_SHA = "8367184a607fbe07a78b650c0d359e5ebbd96f7e2b22f95f761f559b63430386"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    assert digest(ENGINE / "trellis-cli") == "dbf169362d6eee5c77479e8b3428587ba19ce7daa86d7919ec8ed4583fd46643", "engine hash mismatch"
    assert digest(MODELS / "manifest.json") == "f13de62be0b5514e3fe9ff3c9c0a4859894f9b086d81c0e6678445b07c2d313f", "manifest hash mismatch"
    manifest = json.loads((MODELS / "manifest.json").read_text())
    for item in manifest["files"]:
        path = MODELS / item["file"]
        assert path.resolve().parent == MODELS and not path.is_symlink(), "unsafe weight path"
        assert path.stat().st_size == item["bytes"] and digest(path) == item["sha256"], "weight hash mismatch"
    viewer = ENGINE / "model-viewer-4.1.0.min.js"
    if not viewer.exists():
        source = Path("/srv/ai/results/trellis-trial-20261018/model-viewer.min.js")
        assert digest(source) == VIEWER_SHA, "viewer hash mismatch"
        shutil.copyfile(source, viewer)
    assert digest(viewer) == VIEWER_SHA, "viewer hash mismatch"
    for name in ("", "assets", "jobs", "work", ".trash"):
        path = ROOT / name
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        assert path.resolve() == path and path.stat().st_uid == os.getuid(), "unsafe storage root"
        path.chmod(0o700)
    devices = [p.stat().st_dev for p in (ROOT, ROOT.parent / "images", ROOT.parent / "music")]
    assert len(set(devices)) == 1, "media roots are on different filesystems"
    print(json.dumps({"verified": True, "weights": len(manifest["files"]), "sameFilesystem": True, "artifactRoot": str(ROOT)}))


if __name__ == "__main__":
    main()
