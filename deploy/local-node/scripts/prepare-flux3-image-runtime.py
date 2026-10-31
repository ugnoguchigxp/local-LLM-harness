#!/usr/bin/env python3
"""Validate pre-downloaded FLUX assets and write the optional worker environment; no inference or downloads."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path


def prepare(manifest: dict) -> str:
    required = {"engine", "model", "encoder", "vae", "upsampler", "modelSource", "modelRevision", "engineRevision", "upsamplerRevision"}
    if set(manifest) != required or not all(isinstance(value, str) for value in manifest.values()):
        raise ValueError("manifest must contain exactly the documented runtime paths and revisions")
    for key in ("modelRevision", "engineRevision", "upsamplerRevision"):
        if not re.fullmatch(r"[a-f0-9]{40}", manifest[key]):
            raise ValueError(f"{key} must be an exact commit SHA")
    if manifest["modelSource"] not in ("black-forest-labs/flux-3-image-klein", "leejet/flux-3-image-klein-GGUF"):
        raise ValueError("use the distilled FLUX 3 Klein checkpoint or its leejet GGUF conversion")
    for key in ("engine", "model", "encoder", "vae", "upsampler"):
        value = manifest[key]
        # The unit reads /srv/ai/apps and /srv/ai/models. These values are used
        # as individual systemd arguments, never executable shell expressions.
        if not re.fullmatch(r"/srv/ai/(?:apps|models)/[A-Za-z0-9/._+-]+", value) or ".." in Path(value).parts:
            raise ValueError(f"{key} must be a path under /srv/ai/apps or /srv/ai/models without special characters")
        path = Path(value)
        if not (path.is_dir() if key == "upsampler" else path.is_file()):
            raise ValueError(f"missing runtime asset: {key}")
    if not os.access(manifest["engine"], os.X_OK):
        raise ValueError("native engine is not executable")
    pup = Path(manifest["upsampler"])
    for name in ("config.json", "system_prompts.json", "tokenizer_config.json"):
        if not (pup / name).is_file():
            raise ValueError(f"upsampler is missing {name}")
    prompts = json.loads((pup / "system_prompts.json").read_text())
    if not isinstance(prompts.get("t2i"), str) or not prompts["t2i"].strip():
        raise ValueError("upsampler is missing the official t2i system prompt")
    index = pup / "model.safetensors.index.json"
    shards = set(json.loads(index.read_text())["weight_map"].values()) if index.is_file() else {"model.safetensors"}
    if not shards or any(not isinstance(name, str) or Path(name).name != name or not (pup / name).is_file() for name in shards):
        raise ValueError("upsampler weights are incomplete")
    names = {"engine": "ENGINE", "model": "MODEL", "encoder": "ENCODER", "vae": "VAE",
        "upsampler": "UPSAMPLER", "modelSource": "MODEL_SOURCE", "modelRevision": "MODEL_REVISION"}
    lines = ["# Prepared local FLUX runtime; no downloads or model startup were performed.",
        "# engineRevision=" + manifest["engineRevision"], "# upsamplerRevision=" + manifest["upsamplerRevision"]]
    lines.extend(f'LARM_FLUX3_{name}={manifest[key]}' for key, name in names.items())
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("/srv/ai/config/flux3-image.env"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    content = prepare(manifest)
    if not args.output.is_absolute():
        parser.error("output must be an absolute path")
    # Refuse to overwrite host configuration; prepare a new destination to review changes.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
    print(json.dumps({"environment": str(args.output), "sha256": hashlib.sha256(content.encode()).hexdigest(),
        "modelRevision": manifest["modelRevision"], "modelsStarted": 0}))


if __name__ == "__main__":
    main()
