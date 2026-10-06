#!/usr/bin/env bash
set -euo pipefail

if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "${repo_root}"

while IFS= read -r -d "" script; do
  bash -n "${script}"
done < <(find scripts deploy -type f -name '*.sh' -print0)

python3 - <<'PY'
from pathlib import Path

for root in (Path("scripts"), Path("apps"), Path("deploy")):
    for path in root.rglob("*.py"):
        compile(path.read_bytes(), str(path), "exec")
PY

if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd-analyze is required for unit verification" >&2
  exit 1
fi
if [[ "${CI:-}" == "true" ]]; then
  # Runner images do not contain deployment-only binaries. Keep the unit
  # directives and arguments intact while substituting only the executable.
  unit_check_dir="$(mktemp -d)"
  trap 'rm -r -- "${unit_check_dir}"' EXIT
  for unit in deploy/local-node/systemd/*.service; do
    sed -E 's#^(Exec(Start|StartPre|StartPost|Stop|StopPost|Reload)=)[^[:space:]]+#\1/bin/true#' \
      "${unit}" > "${unit_check_dir}/$(basename "${unit}")"
  done
  systemd-analyze verify "${unit_check_dir}"/*.service
else
  systemd-analyze verify deploy/local-node/systemd/*.service
fi

if grep -En 'network-online\.target' \
  deploy/local-node/systemd/llama-server.service \
  deploy/local-node/systemd/llama-swap-worker.service \
  deploy/local-node/systemd/qwen-asr.service \
  deploy/local-node/systemd/qwen-tts.service \
  deploy/local-node/systemd/voicevox-tts.service; then
  echo "loopback-only Provider services must not depend on network-online.target" >&2
  exit 1
fi

if grep -En '0\.0\.0\.0|\[::\]' \
  deploy/local-node/systemd/llama-server.service \
  deploy/local-node/systemd/llama-swap-worker.service \
  deploy/local-node/systemd/qwen-asr.service \
  deploy/local-node/systemd/qwen-tts.service \
  deploy/local-node/systemd/voicevox-tts.service; then
  echo "production Provider units must not use wildcard listeners" >&2
  exit 1
fi
if grep -En '808[0-4]' deploy/local-node/scripts/prepare-host.sh; then
  echo "prepare-host.sh must not add direct Provider LAN rules" >&2
  exit 1
fi

echo "shell, Python, and systemd checks passed"
