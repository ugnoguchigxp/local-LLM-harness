#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_dir=/srv/ai/apps/ruri-system-one
uv_bin="${LARM_UV_BIN:-/home/ugnoguchi/.local/bin/uv}"
mkdir -p "${runtime_dir}"
if [[ ! -x "${runtime_dir}/.venv/bin/python" ]]; then
  "${uv_bin}" venv --python 3.13 "${runtime_dir}/.venv"
fi
"${uv_bin}" pip install --python "${runtime_dir}/.venv/bin/python" -r "${source_root}/apps/ruri-system-one/requirements.txt"
"${runtime_dir}/.venv/bin/python" -c 'import onnxruntime, tokenizers; assert onnxruntime.__version__ == "1.30.0"; assert tokenizers.__version__ == "0.23.2"'
echo "Ruri CPU runtime prepared at ${runtime_dir}/.venv."
