#!/usr/bin/env bash
set -euo pipefail

runtime_dir="/srv/ai/apps/laya-system-one"
venv_dir="${runtime_dir}/.venv"
uv_bin="/home/ugnoguchi/.local/bin/uv"
python_bin="/home/ugnoguchi/.local/bin/python3.13"

if [[ "$(id -un)" != "ugnoguchi" ]]; then
  echo "Run as ugnoguchi: $0" >&2
  exit 1
fi
test -x "${uv_bin}"
test -x "${python_bin}"
mkdir -p "${runtime_dir}"
if [[ ! -x "${venv_dir}/bin/python" ]]; then
  "${uv_bin}" venv --python "${python_bin}" "${venv_dir}"
fi
"${uv_bin}" pip install --python "${venv_dir}/bin/python" \
  --index-url https://download.pytorch.org/whl/cpu torch==2.11.0
"${uv_bin}" pip install --python "${venv_dir}/bin/python" \
  'laya[serve]==0.3.20'
"${venv_dir}/bin/python" -c 'import laya; assert laya.__version__ == "0.3.20"'
echo "Laya runtime prepared at ${venv_dir} (laya 0.3.20, CPU)."
