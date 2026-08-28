#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
headers=()
if [[ -n "${LARM_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")
fi
iterations="${LARM_CANARY_ITERATIONS:-3}"
if [[ ! "${iterations}" =~ ^[1-9][0-9]?$ ]]; then
  echo "LARM_CANARY_ITERATIONS must be between 1 and 99" >&2
  exit 2
fi

cd "${repo_root}"
bun test packages/core/src/registry.test.ts packages/core/src/artifacts.test.ts >/dev/null

health_before="$(curl -fsS --max-time 10 "${base_url}/health")"
epoch_before="$(jq -er '.bootEpoch' <<<"${health_before}")"
started_ns="$(date +%s%N)"
for ((iteration = 1; iteration <= iterations; iteration += 1)); do
  deploy/gnosis/scripts/smoke-larm.sh >/dev/null
done
elapsed_ns=$(( $(date +%s%N) - started_ns ))

if [[ -n "${LARM_CANARY_AUDIO_FILE:-}" ]]; then
  deploy/gnosis/scripts/smoke-voice.sh >/dev/null
fi

health_after="$(curl -fsS --max-time 10 "${base_url}/health")"
epoch_after="$(jq -er '.bootEpoch' <<<"${health_after}")"
if [[ "${epoch_before}" != "${epoch_after}" ]]; then
  echo "daemon boot epoch changed during the canary" >&2
  exit 1
fi

duration_ms=$((elapsed_ns / 1000000))
average_ms=$((duration_ms / iterations))
echo "canary passed: iterations=${iterations} total_ms=${duration_ms} average_ms=${average_ms} boot_epoch=${epoch_after}"
metrics_output="$(curl -fsS --max-time 10 "${headers[@]}" "${base_url}/metrics")"
if awk '
  /^larm_(active_allocations|execution_active|execution_queued)(\{| )/ && ($NF + 0) != 0 { leaked = 1 }
  END { exit leaked ? 1 : 0 }
' <<<"${metrics_output}"; then
  :
else
  echo "canary left an active Allocation or execution slot" >&2
  exit 1
fi
grep -E '^larm_(active_allocations|allocation|gateway|execution_)' <<<"${metrics_output}" || true
