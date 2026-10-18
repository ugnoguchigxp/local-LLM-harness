#!/usr/bin/env bash
set -euo pipefail

# Install only into dedicated evaluation environments, never service runtimes.
vision_eval_root="${VISION_EVAL_ROOT:-/srv/ai/apps/vision-recognition-eval}"
vision_script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p -- "$vision_eval_root"
for vision_env in .venv florence-legacy; do
  if [[ ! -f "$vision_eval_root/$vision_env/pyvenv.cfg" ]]; then
    uv venv --python 3.12 "$vision_eval_root/$vision_env"
  fi
  uv pip install --python "$vision_eval_root/$vision_env/bin/python" \
    'torch==2.11.0+cpu' 'torchvision==0.26.0+cpu' \
    --index https://download.pytorch.org/whl/cpu
done
uv pip install --python "$vision_eval_root/.venv/bin/python" -r "$vision_script_root/requirements.lock"
uv pip install --python "$vision_eval_root/florence-legacy/bin/python" -r "$vision_script_root/requirements-florence.lock"
