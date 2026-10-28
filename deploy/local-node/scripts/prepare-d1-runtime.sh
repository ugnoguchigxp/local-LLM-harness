#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_root=/srv/ai/apps/d1-system-one-v2
uv_bin="${LARM_UV_BIN:-/home/ugnoguchi/.local/bin/uv}"
mkdir -p "${runtime_root}"
if [[ ! -x "${runtime_root}/.venv/bin/python" ]]; then
  "${uv_bin}" venv --python 3.11 "${runtime_root}/.venv"
fi
"${uv_bin}" pip install --python "${runtime_root}/.venv/bin/python" \
  --index https://repo.amd.com/rocm/whl/gfx1151/ --default-index https://pypi.org/simple \
  'torch==2.11.0+rocm7.13.0' 'torchvision==0.26.0+rocm7.13.0'
"${uv_bin}" pip install --python "${runtime_root}/.venv/bin/python" \
  -r "${source_root}/apps/d1-system-one/requirements.lock"
"${runtime_root}/.venv/bin/python" -c 'import torch, transformers; assert torch.__version__ == "2.11.0+rocm7.13.0"; assert transformers.__version__ == "5.20.2"; assert torch.cuda.is_available(); assert torch.cuda.get_device_properties(0).gcnArchName.startswith("gfx1151")'
echo "d1 runtime prepared outside the source repository (ROCm gfx1151)."
