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

echo "shell, Python, and systemd checks passed"
