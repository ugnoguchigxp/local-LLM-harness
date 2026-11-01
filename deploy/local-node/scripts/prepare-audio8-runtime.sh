#!/usr/bin/env bash
set -euo pipefail
# Copy the host's already validated ROCm environment without mutating that TTS.
# All entrypoints use python -m: copied console-script shebangs are not relied on.
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_root="${AUDIO8_RUNTIME_ROOT:-/srv/ai/apps/audio8-tts-runtime}"
seed_env="${AUDIO8_ROCM_SEED_ENV:-/srv/ai/apps/qwen-speech/tts/.venv}"
sample_root="${AUDIO8_REFERENCE_SAMPLES:-/srv/ai/results/larm/tts/2026-11-01-audio8-realistic}"
selected_root="${AUDIO8_SELECTED_VOICE_SAMPLES:-/srv/ai/results/larm/tts/2026-11-01-audio8-dry-husky-tone-speed143}"
case "$(realpath -m "${runtime_root}")/" in
  "${source_root}/"*) echo "Runtime must be outside the source repository" >&2; exit 1 ;;
esac
mkdir -p "${runtime_root}"
if [[ ! -x "${runtime_root}/.venv/bin/python" ]]; then
  if [[ -e "${runtime_root}/.venv" ]]; then
    echo "Refusing to overwrite an incomplete runtime environment" >&2
    exit 1
  fi
  test -x "${seed_env}/bin/python"
  cp -a --reflink=auto "${seed_env}" "${runtime_root}/.venv"
fi
"${runtime_root}/.venv/bin/python" -B - "${source_root}" <<'PY'
import importlib.metadata as metadata
from pathlib import Path
import shutil
import subprocess
import sys
for line in (Path(sys.argv[1])/'apps/audio8-tts/requirements.txt').read_text().splitlines():
    if not line or line.startswith('#'): continue
    name, version = line.split('==')
    if metadata.version(name) != version: raise SystemExit(f'Pinned dependency mismatch: {name}')
import torch
if not torch.cuda.is_available(): raise SystemExit('Validated ROCm GPU is unavailable')
if shutil.which('ffmpeg') is None: raise SystemExit('The default Audio8 voice requires FFmpeg')
filters = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True, check=True).stdout
if ' atempo ' not in filters or ' equalizer ' not in filters:
    raise SystemExit('FFmpeg must support atempo and equalizer')
PY
uv pip freeze --python "${runtime_root}/.venv/bin/python" > "${runtime_root}/requirements-lock.txt"
"${runtime_root}/.venv/bin/python" -B "${source_root}/deploy/local-node/scripts/prepare-audio8-voices.py" \
  --samples "${sample_root}" --selected-samples "${selected_root}" \
  --output /srv/ai/models/Edge0/audio8-ja-voices-v2
printf '%s\n' "Audio8 runtime prepared. No Provider was started or enabled."
