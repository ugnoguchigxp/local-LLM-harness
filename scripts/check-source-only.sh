#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

failed=0
max_source_bytes=$((5 * 1024 * 1024))

while IFS= read -r -d "" file; do
  case "${file}" in
    bin/*|bin-*/*|build/*|build-*/*|dist/*|vendor/*|models/*|\
    *.exe|*.dll|*.so|*.dylib|*.a|*.lib|*.pdb|*.bin|*.zip|*.7z|*.tar|*.tar.gz|*.tgz|\
    *.gguf|*.safetensors|*.onnx|*.vvm)
      echo "forbidden tracked artifact: ${file}" >&2
      failed=1
      continue
      ;;
  esac

  size="$(wc -c < "${file}")"
  if (( size > max_source_bytes )); then
    echo "tracked file exceeds 5 MiB source limit: ${file} (${size} bytes)" >&2
    failed=1
  fi
done < <(git ls-files -z)

if (( failed != 0 )); then
  exit 1
fi

echo "source-only check passed"
