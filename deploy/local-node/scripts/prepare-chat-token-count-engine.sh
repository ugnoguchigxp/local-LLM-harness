#!/usr/bin/env bash
set -euo pipefail
# Build the private MTMD-aware count extension without putting engines in this repository.
chat_engine_source="${LARM_CHAT_ENGINE_SOURCE:?set the external ROCmFPX source checkout}"
chat_engine_build="${LARM_CHAT_ENGINE_BUILD:?set the external configured CMake build directory}"
chat_engine_output="${LARM_CHAT_ENGINE_OUTPUT:?set the external output directory}"
chat_engine_patch="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/patches/llama-chat-token-count-v1.patch"
[[ "${chat_engine_source}" == /* && "${chat_engine_build}" == /* && "${chat_engine_output}" == /* && "${chat_engine_output}" != / ]]
[[ "$(git -C "${chat_engine_source}" rev-parse HEAD)" == 0fc9568e07ccc8553010864cb8db1957e629cbfa ]]
if git -C "${chat_engine_source}" apply --reverse --check "${chat_engine_patch}" 2>/dev/null; then
  : # Already installed; preserve unrelated local engine changes.
else
  git -C "${chat_engine_source}" apply --check "${chat_engine_patch}"
  git -C "${chat_engine_source}" apply "${chat_engine_patch}"
fi
cmake --build "${chat_engine_build}" --target llama-server -j "${LARM_CHAT_ENGINE_JOBS:-4}"
install -d -m 0755 "${chat_engine_output}"
if [[ -e "${chat_engine_output}/llama-server" ]] && ! cmp -s "${chat_engine_build}/bin/llama-server" "${chat_engine_output}/llama-server"; then
  echo 'output contains a different engine; choose a new versioned output directory' >&2
  exit 1
fi
install -m 0755 "${chat_engine_build}/bin/llama-server" "${chat_engine_output}/llama-server"
sha256sum "${chat_engine_output}/llama-server" "${chat_engine_patch}"
