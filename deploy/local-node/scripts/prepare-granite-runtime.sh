#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_root=/srv/ai/apps/granite-asr-runtime
model_root=/srv/ai/models/granite-asr
native_revision=5d66f60257a75e9bdbddc72dc0887b32e9d4841a
model_revision=5fa89dfac74d52a186f63647553b9e1f7ae36e83
model_name=granite-speech-4.1-2b-Q8_0.gguf
model_sha256=666d2f7736bfa140f44d67ba7bcb0827aa5718462f13850af294d72c1f09b218
evaluation_root=/srv/ai/apps/asr-eval-20261012
[[ $(id -u) -ne 0 ]] || { echo 'Prepare the runtime as the LARM operator, not root.' >&2; exit 1; }
for path in "${runtime_root}" "${model_root}"; do
  [[ ! -L ${path} ]] || { echo "Refusing symlink directory: ${path}" >&2; exit 1; }
  mkdir -p "${path}"
done
if [[ ! -e ${model_root}/${model_name} ]]; then
  if [[ -f /srv/ai/models/asr-eval-20261012/${model_name} ]]; then
    cp --reflink=auto /srv/ai/models/asr-eval-20261012/"${model_name}" "${model_root}/${model_name}.partial"
  else
    curl -fL --retry 3 "https://huggingface.co/handy-computer/granite-speech-4.1-2b-gguf/resolve/${model_revision}/${model_name}" \
      -o "${model_root}/${model_name}.partial"
  fi
  printf '%s  %s\n' "${model_sha256}" "${model_root}/${model_name}.partial" | sha256sum --check --status
  mv "${model_root}/${model_name}.partial" "${model_root}/${model_name}"
fi
[[ ! -L ${model_root}/${model_name} ]]
printf '%s  %s\n' "${model_sha256}" "${model_root}/${model_name}" | sha256sum --check --status
if [[ ! -d ${runtime_root}/transcribe.cpp/.git ]]; then
  if [[ -d ${evaluation_root}/transcribe.cpp/.git ]]; then
    git clone --no-hardlinks "${evaluation_root}/transcribe.cpp" "${runtime_root}/transcribe.cpp"
  else
    git clone https://github.com/handy-computer/transcribe.cpp.git "${runtime_root}/transcribe.cpp"
  fi
  git -C "${runtime_root}/transcribe.cpp" checkout --detach "${native_revision}"
fi
[[ $(git -C "${runtime_root}/transcribe.cpp" rev-parse HEAD) == "${native_revision}" ]]
[[ -z $(git -C "${runtime_root}/transcribe.cpp" status --porcelain --untracked-files=no) ]]
mkdir -p "${runtime_root}/deps/root"
for package in libopenblas0-pthread libopenblas-pthread-dev; do
  archive="${package}_0.3.32+ds-5_amd64.deb"
  case "${package}" in
    libopenblas0-pthread) package_sha256=50b0ff9cf93ead2cee575807f77c3a534efb4fe5083f17a05c66e64964c1dd48 ;;
    libopenblas-pthread-dev) package_sha256=c24b957faed5ab0ef965f858bc38c3016d5937df6398e27f1883d2318b26a191 ;;
  esac
  if [[ ! -f ${runtime_root}/deps/${archive} ]]; then
    if [[ -f ${evaluation_root}/deps/${archive} ]]; then
      cp "${evaluation_root}/deps/${archive}" "${runtime_root}/deps/${archive}"
    else
      curl -fL --retry 3 "https://archive.ubuntu.com/ubuntu/pool/universe/o/openblas/${archive}" -o "${runtime_root}/deps/${archive}"
    fi
  fi
  printf '%s  %s\n' "${package_sha256}" "${runtime_root}/deps/${archive}" | sha256sum --check --status
  dpkg-deb -x "${runtime_root}/deps/${archive}" "${runtime_root}/deps/root"
done
cmake -S "${runtime_root}/transcribe.cpp" -B "${runtime_root}/transcribe.cpp/build-vulkan" \
  -DCMAKE_BUILD_TYPE=Release -DTRANSCRIBE_VULKAN=ON -DGGML_VULKAN=ON -DGGML_NATIVE=ON \
  -DTRANSCRIBE_BUILD_SHARED=ON -DTRANSCRIBE_BUILD_TESTS=OFF -DTRANSCRIBE_USE_SYSTEM_BLAS=ON \
  -DBLA_VENDOR=OpenBLAS \
  -DBLAS_openblas_LIBRARY="${runtime_root}/deps/root/usr/lib/x86_64-linux-gnu/openblas-pthread/libopenblas.so" \
  -DCMAKE_CXX_FLAGS="-I${runtime_root}/deps/root/usr/include/x86_64-linux-gnu/openblas-pthread"
cmake --build "${runtime_root}/transcribe.cpp/build-vulkan" --target transcribe -j8
if [[ ! -x ${runtime_root}/.venv/bin/python ]]; then
  uv venv --python 3.12 "${runtime_root}/.venv"
fi
uv pip install --python "${runtime_root}/.venv/bin/python" -r "${source_root}/apps/granite-asr/requirements.txt"
echo 'Granite dialogue runtime prepared with pinned engine and model identities.'
