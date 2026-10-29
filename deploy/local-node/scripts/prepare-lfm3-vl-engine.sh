#!/usr/bin/env bash
set -euo pipefail
# The source is an isolated, already-patched worktree; never mutate it here.
source_dir="${LARM_LFM3_VL_ENGINE_SOURCE:-/srv/ai/apps/llama-lfm3-vl-larm-20261028}"
build_dir="${LARM_LFM3_VL_ENGINE_BUILD:-${source_dir}/build-vulkan}"
output_dir="${LARM_LFM3_VL_ENGINE_OUTPUT:-/srv/ai/apps/larm-lfm3-vl-19cce69-v1}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
patch_file="${repo_dir}/deploy/local-node/patches/llama-lfm3-vl-token-count-19cce69-experimental.patch"
revision=19cce6919992fdffd92e0ac152caaf1e2b8f254e
for path in "${source_dir}" "${build_dir}" "${output_dir}"; do
  [[ "${path}" == /* && "${path}" != / ]] || { echo 'paths must be absolute and non-root' >&2; exit 1; }
  resolved="$(realpath -m "${path}")"
  [[ "${resolved}" != "${repo_dir}" && "${resolved}" != "${repo_dir}/"* ]] || { echo 'engine assets must stay outside the repository' >&2; exit 1; }
done
[[ ! -e "${output_dir}" ]] || { echo 'output already exists; choose a new directory' >&2; exit 1; }
[[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${revision}" ]] || { echo 'source revision mismatch' >&2; exit 1; }
[[ -z "$(git -C "${source_dir}" ls-files --others --exclude-standard)" ]] || { echo 'unexpected untracked source files' >&2; exit 1; }
git -C "${source_dir}" diff --cached --quiet || { echo 'staged source changes are not supported' >&2; exit 1; }
[[ "$(git -C "${source_dir}" diff --binary | sha256sum | cut -d' ' -f1)" == "$(sha256sum "${patch_file}" | cut -d' ' -f1)" ]] || { echo 'source patch differs from the pinned extension' >&2; exit 1; }
[[ "$(realpath "$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "${build_dir}/CMakeCache.txt")")" == "$(realpath "${source_dir}")" ]] || { echo 'build source mismatch' >&2; exit 1; }
grep -qx 'CMAKE_BUILD_TYPE:STRING=Release' "${build_dir}/CMakeCache.txt" || { echo 'Release build required' >&2; exit 1; }
cmake --build "${build_dir}" --target llama-server -j "${LARM_LFM3_VL_BUILD_JOBS:-4}"
mkdir -p "$(dirname "${output_dir}")"
staging="$(mktemp -d "${output_dir}.preparing.XXXXXX")"
trap 'rm -rf -- "${staging}"' EXIT
cp -a "${build_dir}/bin/llama-server" "${staging}/llama-server.bin"
cp -a "${build_dir}"/bin/lib*.so* "${staging}/"
cat > "${staging}/llama-server" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
engine_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${engine_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec "${engine_dir}/llama-server.bin" "$@"
WRAPPER
chmod 0755 "${staging}/llama-server"
version="$("${staging}/llama-server" --version 2>&1)"
[[ "${version}" == *19cce69* ]] || { echo 'binary revision mismatch' >&2; exit 1; }
printf '%s\n' "${revision}" > "${staging}/SOURCE_REVISION"
(cd "${staging}" && sha256sum llama-server llama-server.bin lib*.so* > SHA256SUMS)
mv -T "${staging}" "${output_dir}"
trap - EXIT
printf 'prepared %s\n%s\n' "${output_dir}" "${version}"
