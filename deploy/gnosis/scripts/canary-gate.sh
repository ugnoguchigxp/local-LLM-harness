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
evidence_dir="${LARM_CANARY_EVIDENCE_DIR:-}"
if [[ "${evidence_dir}" != /* || "${evidence_dir}" == "${repo_root}"* || -L "${evidence_dir}" ]]; then
  echo "LARM_CANARY_EVIDENCE_DIR must be an absolute repository-external non-symlink path" >&2
  exit 2
fi
if [[ -z "${LARM_BENCHMARK_AUDIO_FILE:-}" || "${LARM_BENCHMARK_AUDIO_FILE}" != /* \
  || ! -f "${LARM_BENCHMARK_AUDIO_FILE}" || -L "${LARM_BENCHMARK_AUDIO_FILE}" ]]; then
  echo "LARM_BENCHMARK_AUDIO_FILE must be an absolute regular non-sensitive audio fixture" >&2
  exit 2
fi

cd "${repo_root}"
bun test packages/core/src/registry.test.ts packages/core/src/artifacts.test.ts >/dev/null
deploy/gnosis/scripts/shadow-larm.sh >/dev/null

health_before="$(curl -fsS --max-time 10 "${base_url}/health")"
epoch_before="$(jq -er '.bootEpoch' <<<"${health_before}")"
config_revision="$(jq -er '.configRevision' <<<"${health_before}")"
deployed_commit="$(jq -er '.releaseCommit | select(test("^[a-f0-9]{40}$"))' <<<"${health_before}")"
repository_commit="$(git rev-parse HEAD)"
[[ "${deployed_commit}" == "${repository_commit}" ]] || {
  echo "deployed release commit does not match the canary worktree" >&2
  exit 1
}
[[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || {
  echo "canary worktree must be clean" >&2
  exit 1
}
install -d -m 0700 -- "${evidence_dir}"
run_id="$(date --utc +%Y%m%dT%H%M%SZ)-${deployed_commit:0:12}"
raw_output="${evidence_dir}/${run_id}-raw.json"
summary_output="${evidence_dir}/${run_id}-summary.json"
comparison_output="${evidence_dir}/${run_id}-comparison.json"
LARM_BENCHMARK_OUTPUT="${raw_output}" \
LARM_BENCHMARK_SUMMARY="${summary_output}" \
LARM_BENCHMARK_COMMIT="${deployed_commit}" \
LARM_BENCHMARK_ITERATIONS="${iterations}" \
LARM_BENCHMARK_SERIES=all \
LARM_BENCHMARK_AUDIO_FILE="${LARM_BENCHMARK_AUDIO_FILE}" \
bun run deploy/gnosis/scripts/benchmark-larm.ts >/dev/null
LARM_SLO_SUMMARY="${summary_output}" \
LARM_SLO_EXPECTED_COMMIT="${deployed_commit}" \
LARM_SLO_EXPECTED_CONFIG_REVISION="${config_revision}" \
bun run deploy/gnosis/scripts/compare-slo.ts >"${comparison_output}"
chmod 0600 -- "${comparison_output}"

LARM_CANARY_AUDIO_FILE="${LARM_BENCHMARK_AUDIO_FILE}" deploy/gnosis/scripts/smoke-voice.sh >/dev/null

health_after="$(curl -fsS --max-time 10 "${base_url}/health")"
epoch_after="$(jq -er '.bootEpoch' <<<"${health_after}")"
if [[ "${epoch_before}" != "${epoch_after}" ]]; then
  echo "daemon boot epoch changed during the canary" >&2
  exit 1
fi

metrics_output="$(curl -fsS --max-time 10 "${headers[@]}" "${base_url}/metrics")"
if awk '
  /^larm_active_allocations(\{| )/ { allocations = 1; if (($NF + 0) != 0) leaked = 1 }
  /^larm_execution_active(\{| )/ { execution_active = 1; if (($NF + 0) != 0) leaked = 1 }
  /^larm_execution_queued(\{| )/ { execution_queued = 1; if (($NF + 0) != 0) leaked = 1 }
  /^larm_artifact_operations_active(\{| )/ { artifact_operations = 1; if (($NF + 0) != 0) leaked = 1 }
  END { exit leaked || !allocations || !execution_active || !execution_queued || !artifact_operations ? 1 : 0 }
' <<<"${metrics_output}"; then
  :
else
  echo "canary gauge is missing or an Allocation, execution slot, or artifact operation leaked" >&2
  exit 1
fi
grep -E '^larm_(active_allocations|allocation|gateway|execution_|artifact_operations_active)' <<<"${metrics_output}" || true
echo "canary passed: series=4 iterations=${iterations} commit=${deployed_commit} config_revision=${config_revision} boot_epoch=${epoch_after}"
