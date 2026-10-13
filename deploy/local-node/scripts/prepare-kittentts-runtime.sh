#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_root=/srv/ai/apps/kittentts-runtime
mkdir -p "${runtime_root}"
wheel="${runtime_root}/kittentts-0.8.1-py3-none-any.whl"
if [[ ! -f "${wheel}" ]]; then
  curl --fail --location --output "${wheel}.part" https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl
  mv "${wheel}.part" "${wheel}"
fi
printf '%s  %s\n' 482a436c4f1f3192153710376e459ff3689517ebcda7c2b051e2fd4187b41851 "${wheel}" | sha256sum --check --status
if [[ ! -x "${runtime_root}/.venv/bin/python" ]]; then
  uv venv --python 3.12 "${runtime_root}/.venv"
fi
# Install Torch's CPU build before the official frontend dependencies to avoid
# downloading CUDA libraries on this AMD CPU deployment.
uv pip install --python "${runtime_root}/.venv/bin/python" torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
uv pip install --python "${runtime_root}/.venv/bin/python" -r "${source_root}/apps/kittentts-tts/requirements.lock"
python3 "${source_root}/benchmarks/tts/kittentts/download.py" --output /srv/ai/models/kittentts
uv pip freeze --python "${runtime_root}/.venv/bin/python" > "${runtime_root}/requirements-lock.txt"
echo "Pinned KittenTTS CPU runtime and model artifacts are ready."
