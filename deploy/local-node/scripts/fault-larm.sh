#!/usr/bin/env bash
set -euo pipefail

action="${1:-plan}"
base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
confirm="${LARM_FAULT_CONFIRM:-}"
resident_units=(llama-server.service larm-native-qwen-provider.service qwen-asr.service whisper-asr.service voicevox-tts.service)
management_headers=()
if [[ -n "${LARM_API_TOKEN:-}" ]]; then
  management_headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")
fi
if [[ -n "${LARM_MANAGEMENT_TOKEN:-}" ]]; then
  management_headers+=(-H "X-LARM-Management-Token: ${LARM_MANAGEMENT_TOKEN}")
fi

pid_snapshot() {
  for unit in "${resident_units[@]}"; do
    printf '%s=%s\n' "${unit}" "$(systemctl show "${unit}" -p MainPID --value)"
  done
}

wait_artifact_operation() {
  local id="$1" deadline=$((SECONDS + 600)) body status
  while ((SECONDS < deadline)); do
    body="$(curl -fsS --max-time 5 "${management_headers[@]}" "${base_url}/v1/artifact-operations/${id}")"
    status="$(jq -er .status <<<"${body}")"
    case "${status}" in
      succeeded) return 0 ;;
      failed|interrupted) jq -c '{id,status,error}' <<<"${body}" >&2; return 1 ;;
    esac
    sleep 1
  done
  return 1
}

wait_ready() {
  local deadline=$((SECONDS + 90))
  until curl -fsS --max-time 3 "${base_url}/ready" >/dev/null; do
    ((SECONDS < deadline)) || return 1
    sleep 1
  done
}

case "${action}" in
  plan)
    jq -n --arg daemon "$(systemctl is-active larm-daemon.service 2>/dev/null || true)" \
      --arg preferred "$(systemctl is-active qwen-tts.service 2>/dev/null || true)" \
      '{availableActions:["daemon-restart","preferred-kill","preferred-stall","artifact-rollback"],daemon:$daemon,preferred:$preferred,confirmation:"LARM_FAULT_CONFIRM=local-node-attended"}'
    ;;
  daemon-restart)
    [[ "${confirm}" == "local-node-attended" ]] || { echo "attended confirmation required" >&2; exit 2; }
    before="$(pid_snapshot)"
    epoch="$(curl -fsS --max-time 5 "${base_url}/health" | jq -er .bootEpoch)"
    systemctl kill --signal=KILL larm-daemon.service
    wait_ready
    next_epoch="$(curl -fsS --max-time 5 "${base_url}/health" | jq -er .bootEpoch)"
    [[ "${epoch}" != "${next_epoch}" ]] || { echo "boot epoch did not change" >&2; exit 1; }
    [[ "$(pid_snapshot)" == "${before}" ]] || { echo "resident Provider PID changed" >&2; exit 1; }
    echo "daemon restart fault passed"
    ;;
  preferred-kill)
    [[ "${confirm}" == "local-node-attended" ]] || { echo "attended confirmation required" >&2; exit 2; }
    systemctl is-active --quiet qwen-tts.service || { echo "qwen-tts is not active" >&2; exit 2; }
    systemctl kill --signal=KILL qwen-tts.service
    deadline=$((SECONDS + 90))
    until ! systemctl is-active --quiet qwen-tts.service \
      || curl -fsS --max-time 3 http://127.0.0.1:8082/health >/dev/null; do
      ((SECONDS < deadline)) || { echo "preferred provider did not converge" >&2; exit 1; }
      sleep 1
    done
    echo "preferred provider fault injected; verify the owning Allocation operation before release"
    ;;
  preferred-stall)
    [[ "${confirm}" == "local-node-attended" ]] || { echo "attended confirmation required" >&2; exit 2; }
    systemctl is-active --quiet qwen-tts.service || { echo "qwen-tts is not active" >&2; exit 2; }
    before="$(pid_snapshot)"
    systemctl kill --signal=STOP qwen-tts.service
    resume() { systemctl kill --signal=CONT qwen-tts.service >/dev/null 2>&1 || true; }
    trap resume EXIT
    if curl -fsS --max-time 2 http://127.0.0.1:8082/health >/dev/null 2>&1; then
      echo "preferred provider did not stall" >&2
      exit 1
    fi
    resume
    trap - EXIT
    deadline=$((SECONDS + 90))
    until curl -fsS --max-time 3 http://127.0.0.1:8082/health >/dev/null; do
      ((SECONDS < deadline)) || { echo "preferred provider did not recover from stall" >&2; exit 1; }
      sleep 1
    done
    [[ "$(pid_snapshot)" == "${before}" ]] || { echo "resident Provider PID changed" >&2; exit 1; }
    echo "preferred provider stall and recovery passed"
    ;;
  artifact-rollback)
    [[ "${confirm}" == "local-node-attended" ]] || { echo "attended confirmation required" >&2; exit 2; }
    [[ -n "${LARM_MANAGEMENT_TOKEN:-}" ]] || { echo "LARM_MANAGEMENT_TOKEN is required" >&2; exit 2; }
    runtime="${LARM_FAULT_RUNTIME:-qwen-tts}"
    before="$(pid_snapshot)"
    deployment="$(curl -fsS --max-time 5 "${management_headers[@]}" "${base_url}/v1/deployments/${runtime}")"
    previous="$(jq -r '.previousRelease // empty' <<<"${deployment}")"
    [[ -n "${previous}" ]] || { echo "runtime ${runtime} has no rollback release" >&2; exit 2; }
    operation="$(curl -fsS --max-time 10 -X POST "${management_headers[@]}" \
      -H 'Content-Type: application/json' "${base_url}/v1/deployments/${runtime}/rollback")"
    operation_id="$(jq -er .id <<<"${operation}")"
    wait_artifact_operation "${operation_id}" || { echo "artifact rollback failed" >&2; exit 1; }
    active="$(curl -fsS --max-time 5 "${management_headers[@]}" "${base_url}/v1/deployments/${runtime}" | jq -er .activeRelease)"
    [[ "${active}" == "${previous}" ]] || { echo "rollback did not activate ${previous}" >&2; exit 1; }
    [[ "$(pid_snapshot)" == "${before}" ]] || { echo "resident Provider PID changed" >&2; exit 1; }
    echo "artifact rollback passed: runtime=${runtime} release=${previous}"
    ;;
  *)
    echo "usage: $0 plan|daemon-restart|preferred-kill|preferred-stall|artifact-rollback" >&2
    exit 2
    ;;
esac
