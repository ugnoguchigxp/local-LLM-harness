#!/usr/bin/env bash
set -euo pipefail

model=/srv/ai/models/halofpx/ornith-1.5-35b/Ornith-1.5-35B-A3B-ROCmFP4.gguf
expected_bytes=19052438944
expected_sha=0f907917a1bfe4e0ca0d281e5709dcf34b6277063e94fab29491bb5c80fda696
rejected_sha=b42fb74cd32ce3ab5fc0b10214ae7b4030d852f49b749dcdd0e5ad6b35e1510f
engine="${ORNITH_BENCH_ENGINE:-/srv/ai/apps/q38rocm/engine/bin/llama-server}"
port="${ORNITH_BENCH_PORT:-18090}"
output_dir="${ORNITH_BENCH_OUTPUT_DIR:?set ORNITH_BENCH_OUTPUT_DIR to a new directory outside the repository}"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
server_pid=
sampler_pid=

cleanup() {
  if [[ -n "${sampler_pid}" ]] && kill -0 "${sampler_pid}" 2>/dev/null; then
    kill "${sampler_pid}" 2>/dev/null || true
    wait "${sampler_pid}" 2>/dev/null || true
  fi
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

case "${output_dir}" in
  /*) ;;
  *) echo "ORNITH_BENCH_OUTPUT_DIR must be absolute" >&2; exit 2 ;;
esac
case "${output_dir}/" in
  "${repo_root}/"*) echo "benchmark evidence must stay outside the repository" >&2; exit 2 ;;
esac
[[ ! -e "${output_dir}" ]] || { echo "refusing to overwrite ${output_dir}" >&2; exit 2; }
install -d -m 0700 "${output_dir}"

[[ -x "${engine}" ]] || { echo "missing engine: ${engine}" >&2; exit 2; }
[[ -f "${model}" ]] || { echo "missing refreshed model: ${model}" >&2; exit 2; }
actual_bytes=$(stat -Lc %s "${model}")
[[ "${actual_bytes}" == "${expected_bytes}" ]] || {
  echo "model byte count mismatch: expected ${expected_bytes}, got ${actual_bytes}" >&2
  exit 2
}
actual_sha=$(sha256sum "${model}" | awk '{print $1}')
[[ "${actual_sha}" != "${rejected_sha}" ]] || {
  echo "refusing the pre-refresh Ornith artifact ${rejected_sha}" >&2
  exit 2
}
[[ "${actual_sha}" == "${expected_sha}" ]] || {
  echo "model SHA256 mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 2
}
if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "benchmark port ${port} is already in use" >&2
  exit 2
fi

"${engine}" --version >"${output_dir}/engine-version.txt" 2>&1
uname -a >"${output_dir}/uname.txt"
lscpu >"${output_dir}/lscpu.txt"

sample_resources() {
  local case_name=$1
  local sample_file="${output_dir}/${case_name}-resources.tsv"
  printf 'unix_ms\trss_kib\tgpu_busy_percent\tgtt_used_bytes\tvram_used_bytes\n' >"${sample_file}"
  while kill -0 "${server_pid}" 2>/dev/null; do
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$(date +%s%3N)" \
      "$(awk '/VmRSS:/ {print $2}' "/proc/${server_pid}/status" 2>/dev/null || true)" \
      "$(sed -n '1p' /sys/class/drm/card1/device/gpu_busy_percent 2>/dev/null || true)" \
      "$(sed -n '1p' /sys/class/drm/card1/device/mem_info_gtt_used 2>/dev/null || true)" \
      "$(sed -n '1p' /sys/class/drm/card1/device/mem_info_vram_used 2>/dev/null || true)" \
      >>"${sample_file}"
    sleep 0.25
  done
}

run_case() {
  local case_name=$1
  shift
  "${engine}" \
    -m "${model}" \
    -dev Vulkan0 \
    -ngl 999 \
    --fit off \
    --flash-attn on \
    --ctx-size 131072 \
    --parallel 1 \
    --batch-size 2048 \
    --ubatch-size 1024 \
    --threads 16 \
    --poll 100 \
    --cache-type-k q8_0 \
    --cache-type-v q8_0 \
    --no-mmap \
    --cont-batching \
    --kv-unified \
    --host 127.0.0.1 \
    --port "${port}" \
    --reasoning auto \
    --temp 0.6 \
    --top-p 0.95 \
    --top-k 20 \
    --jinja \
    --context-shift \
    -ctxcp 0 \
    -cram 0 \
    --no-cache-prompt \
    --no-cache-idle-slots \
    --metrics \
    --no-webui \
    "$@" \
    >"${output_dir}/${case_name}-server.log" 2>&1 &
  server_pid=$!

  for _ in $(seq 1 360); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      break
    fi
    kill -0 "${server_pid}" 2>/dev/null || {
      tail -n 80 "${output_dir}/${case_name}-server.log" >&2
      return 1
    }
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null

  sample_resources "${case_name}" &
  sampler_pid=$!
  QWEN_EVAL_BASE_URL="http://127.0.0.1:${port}" \
  QWEN_EVAL_LABEL=ornith-1.5-35b \
  QWEN_EVAL_MODE="${ORNITH_BENCH_EVAL_MODE:-throughput}" \
  QWEN_EVAL_ITERATIONS=3 \
  QWEN_EVAL_MAX_TOKENS=256 \
  QWEN_EVAL_TEMPERATURE=0 \
  QWEN_EVAL_OUTPUT="${output_dir}/${case_name}-evaluation.json" \
    bun run "${repo_root}/deploy/local-node/scripts/evaluate-qwen38-server.ts" \
      >"${output_dir}/${case_name}-evaluation.stdout.json"

  if [[ "${ORNITH_BENCH_TTFC:-0}" == 1 ]]; then
    for thinking_mode in auto off; do
      TTFC_EVAL_BASE_URL="http://127.0.0.1:${port}" \
      TTFC_EVAL_LABEL=ornith-1.5-35b \
      TTFC_EVAL_THINKING="${thinking_mode}" \
      TTFC_EVAL_ITERATIONS=3 \
      TTFC_EVAL_MAX_TOKENS=512 \
      TTFC_EVAL_OUTPUT="${output_dir}/${case_name}-ttfc-${thinking_mode}.json" \
        bun run "${repo_root}/deploy/local-node/scripts/evaluate-streaming-ttfc.ts" \
          >"${output_dir}/${case_name}-ttfc-${thinking_mode}.stdout.json"
    done
  fi

  kill "${sampler_pid}" 2>/dev/null || true
  wait "${sampler_pid}" 2>/dev/null || true
  sampler_pid=
  kill "${server_pid}" 2>/dev/null || true
  wait "${server_pid}" 2>/dev/null || true
  server_pid=
}

run_case mtp-off
run_case mtp-on \
  --spec-type draft-mtp \
  --spec-draft-n-max 4 \
  --spec-draft-p-min 0.6

jq -n \
  --arg model "${model}" \
  --arg sha256 "${actual_sha}" \
  --arg quantization Q4_0_ROCMFP4_STRIX_LEAN \
  --arg backend Vulkan0 \
  --argjson contextSize 131072 \
  --slurpfile bare "${output_dir}/mtp-off-evaluation.json" \
  --slurpfile mtp "${output_dir}/mtp-on-evaluation.json" \
  '{schemaVersion: 1, modelFile: $model, sha256: $sha256, quantization: $quantization,
    backend: $backend, contextSize: $contextSize, mtp: {draftDepth: 4, pMin: 0.6},
    results: {off: $bare[0], on: $mtp[0]}}' \
  >"${output_dir}/summary.json"
printf 'benchmark evidence: %s\n' "${output_dir}"
