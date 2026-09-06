#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

removed_paths=(
  packages/core/src/saaa-llm-stream.ts
  packages/backends/src/native-llm-stream.ts
  apps/daemon/src/llm-stream-session.ts
  deploy/local-node/systemd/larm-native-qwen-provider.service
)
for path in "${removed_paths[@]}"; do
  if [[ -e "${path}" ]]; then
    echo "legacy proprietary streaming path still exists: ${path}" >&2
    exit 1
  fi
done

legacy_route='/v1/llm/'"stream"
legacy_protocol='saaa.llm-'"stream.v1"
legacy_native_protocol='larm.native-llm-'"stream.v1"
legacy_service='larm-native-qwen-'"provider.service"
search_roots=(apps packages config deploy/local-node/systemd deploy/local-node/scripts package.json)
if rg -n --fixed-strings \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.sh' \
  --glob '!**/README.md' \
  --glob '!retire-legacy-websocket.sh' \
  -e "${legacy_route}" \
  -e "${legacy_protocol}" \
  -e "${legacy_native_protocol}" \
  -e "${legacy_service}" \
  "${search_roots[@]}"; then
  echo "legacy proprietary WebSocket contract remains in executable source" >&2
  exit 1
fi

echo "legacy proprietary WebSocket source is absent"
