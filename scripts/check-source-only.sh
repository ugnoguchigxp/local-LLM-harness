#!/usr/bin/env bash
set -euo pipefail

if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  repository_mode="git"
else
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  repository_mode="archive"
fi
cd "${repo_root}"

failed=0
max_source_bytes=$((5 * 1024 * 1024))

list_source_files() {
  if [[ "${repository_mode}" == "git" ]]; then
    git ls-files --cached --others --exclude-standard -z
  else
    find -P . -mindepth 1 \( -type f -o -type l \) \
      ! -path '*/node_modules/*' -printf '%P\0'
  fi
}

while IFS= read -r -d "" file; do
  if [[ ! -e "${file}" && ! -L "${file}" ]]; then
    continue
  fi
  case "${file}" in
    bin/*|*/bin/*|bin-*/*|*/bin-*/*|build/*|*/build/*|build-*/*|*/build-*/*|\
    dist/*|*/dist/*|vendor/*|*/vendor/*|models/*|*/models/*|\
    node_modules/*|*/node_modules/*|\
    coverage/*|*/coverage/*|.cache/*|*/.cache/*|__pycache__/*|*/__pycache__/*|\
    *.exe|*.dll|*.so|*.dylib|*.a|*.lib|*.pdb|*.bin|*.zip|*.7z|*.tar|*.tar.gz|*.tgz|\
    *.gguf|*.safetensors|*.onnx|*.vvm|*.pt|*.pth|*.ckpt|*.pyc|*.pyo|*.log)
      echo "forbidden repository artifact: ${file}" >&2
      failed=1
      continue
      ;;
  esac

  size="$(wc -c < "${file}")"
  if (( size > max_source_bytes )); then
    echo "repository file exceeds 5 MiB source limit: ${file} (${size} bytes)" >&2
    failed=1
  fi
done < <(list_source_files)

if (( failed != 0 )); then
  exit 1
fi

echo "source-only check passed"
