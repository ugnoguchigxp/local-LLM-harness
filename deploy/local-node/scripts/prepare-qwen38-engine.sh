#!/usr/bin/env bash
set -euo pipefail

# Build assets remain outside this source-only repository.
revision=120141f1f9da0a82bb109135c82cd173107fac25
source_dir="${LARM_QWEN38_ENGINE_SOURCE:-/srv/ai/apps/qwen38-rocmfp4-engine-source}"
runtime_dir="${LARM_QWEN38_ENGINE_ROOT:-/srv/ai/apps/larm-qwen38-rocmfp4-engine-120141f-v1}"
build_dir="${source_dir}/build-larm-vulkan"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for external_path in "${source_dir}" "${runtime_dir}"; do
  [[ "${external_path}" == /* && "${external_path}" != / ]] || { echo 'engine paths must be absolute and non-root' >&2; exit 1; }
  resolved="$(realpath -m "${external_path}")"
  [[ "${resolved}" != "${repo_dir}" && "${resolved}" != "${repo_dir}/"* ]] || { echo 'engine assets must stay outside the source repository' >&2; exit 1; }
done
if [[ -e "${runtime_dir}" ]]; then
  echo "runtime already exists: ${runtime_dir}" >&2
  exit 1
fi
if [[ ! -d "${source_dir}/.git" ]]; then
  git clone https://github.com/ROCmFPX/ROCmFPX.git "${source_dir}"
  git -C "${source_dir}" checkout --detach "${revision}"
fi
[[ -z "$(git -C "${source_dir}" status --porcelain)" ]] || { echo 'engine source must be clean' >&2; exit 1; }
[[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${revision}" ]] || { echo 'engine source revision mismatch' >&2; exit 1; }
if [[ -n "${LARM_QWEN38_ENGINE_BUILD:-}" ]]; then
  # Reuse a build of precisely this clean revision when it is already available.
  build_dir="${LARM_QWEN38_ENGINE_BUILD}"
  [[ "$(realpath "$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "${build_dir}/CMakeCache.txt")")" == "$(realpath "${source_dir}")" ]] \
    || { echo 'build does not belong to the pinned source' >&2; exit 1; }
  grep -qx 'GGML_VULKAN:BOOL=ON' "${build_dir}/CMakeCache.txt" \
    || { echo 'engine build must enable Vulkan' >&2; exit 1; }
  grep -qx 'CMAKE_BUILD_TYPE:STRING=Release' "${build_dir}/CMakeCache.txt" \
    || { echo 'engine build must use Release configuration' >&2; exit 1; }
else
  cmake -S "${source_dir}" -B "${build_dir}" -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_WEBUI=OFF
  cmake --build "${build_dir}" --config Release --target llama-server -j "${LARM_QWEN38_BUILD_JOBS:-8}"
fi
mkdir -p "$(dirname "${runtime_dir}")"
staging="$(mktemp -d "${runtime_dir}.preparing.XXXXXX")"
trap 'rm -rf -- "${staging}"' EXIT
cp -a "${build_dir}/bin/llama-server" "${staging}/llama-server.bin"
cp -a "${build_dir}"/bin/lib*.so* "${staging}/"
cat > "${staging}/llama-server" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${runtime_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec "${runtime_dir}/llama-server.bin" "$@"
EOF
chmod 0755 "${staging}/llama-server"
version="$("${staging}/llama-server" --version 2>&1)"
[[ "${version}" == *120141f* ]] || { echo 'engine binary revision mismatch' >&2; exit 1; }
printf '%s\n' "${version}"
(
  cd "${staging}"
  sha256sum llama-server llama-server.bin lib*.so* > SHA256SUMS
  printf '%s\n' "${revision}" > SOURCE_REVISION
)
mv -T "${staging}" "${runtime_dir}"
trap - EXIT
echo "prepared ${runtime_dir}"
