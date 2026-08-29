#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

while IFS= read -r -d "" script; do
  bash -n "${script}"
done < <(find scripts deploy -type f -name '*.sh' -print0)

python3 - <<'PY'
from pathlib import Path

for root in (Path("scripts"), Path("apps")):
    for path in root.rglob("*.py"):
        compile(path.read_bytes(), str(path), "exec")
PY

if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd-analyze is required for unit verification" >&2
  exit 1
fi
systemd-analyze verify deploy/gnosis/systemd/*.service

if rg -n '0\.0\.0\.0|\[::\]' \
  deploy/gnosis/systemd/llama-server.service \
  deploy/gnosis/systemd/llama-swap-worker.service \
  deploy/gnosis/systemd/qwen-asr.service \
  deploy/gnosis/systemd/qwen-tts.service \
  deploy/gnosis/systemd/voicevox-tts.service; then
  echo "production Provider units must not use wildcard listeners" >&2
  exit 1
fi
if rg -n '808[0-4]' deploy/gnosis/scripts/prepare-host.sh; then
  echo "prepare-host.sh must not add direct Provider LAN rules" >&2
  exit 1
fi

echo "shell, Python, and systemd checks passed"
