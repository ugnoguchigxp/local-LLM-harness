#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-status}"
variant="${2:-}"
# Serialize cross-process switches as well as the daemon's in-memory admission.
exec 9>"${LARM_MEDIA_LOCK_PATH:-/srv/ai/cache/larm-media-variant.lock}"
flock -w "${LARM_MEDIA_LOCK_TIMEOUT_SECONDS:-10}" 9 || { echo "media control lock is busy" >&2; exit 1; }
case "${variant}" in
  music) service=larm-music-ace-step.service; health=http://127.0.0.1:8090/health; reserve_gb=18 ;;
  image) service=larm-image-qwen21.service; health=http://127.0.0.1:8091/health; reserve_gb=34 ;;
  image-flux3) service=larm-image-flux3.service; health=http://127.0.0.1:8094/health; reserve_gb=48 ;;
  stable-audio) service=larm-audio-stable.service; health=http://127.0.0.1:8092/health; reserve_gb=6 ;;
  mesh) service=larm-mesh-trellis2.service; health=http://127.0.0.1:8093/health; reserve_gb=32 ;;
  *) echo "usage: $0 status|start|stop music|image|image-flux3|mesh|stable-audio" >&2; exit 2 ;;
esac

ready() {
  local response
  response="$(curl -fsS --max-time 3 "${health}")" || return 1
  python3 -c 'import json,sys; v=json.load(sys.stdin); d=v.get("data",v); sys.exit(0 if ((d.get("ready") is True or d.get("loaded") is True) if sys.argv[1] in ("image", "image-flux3", "mesh") else (v.get("status")=="ok" if sys.argv[1]=="stable-audio" else d.get("models_initialized") is True)) else 1)' "${variant}" <<<"${response}"
}

worker_alive() {
  local state
  state="$(systemctl show "${service}" --property=ActiveState --value)" || return 1
  case "${state}" in
    active|activating|reloading) return 0 ;;
    *) echo "${variant} worker exited before becoming healthy (state=${state})" >&2; return 1 ;;
  esac
}

stop_worker() {
  local unit="$1" state
  timeout 75 systemctl stop "${unit}"
  state="$(systemctl show "${unit}" --property=ActiveState,MainPID --no-pager)"
  if ! [[ "${state}" == *"ActiveState=inactive"* || "${state}" == *"ActiveState=failed"* ]] || ! [[ "${state}" == *"MainPID=0"* ]]; then
    echo "worker did not exit after stop: ${unit}" >&2
    return 1
  fi
}

case "${action}" in
  status)
    systemctl show "${service}" --property=ActiveState,SubState --no-pager
    ;;
  stop)
    stop_worker "${service}"
    ;;
  start)
    if systemctl is-active --quiet "${service}" && ready >/dev/null 2>&1; then
      exit 0
    fi
    # A live peer may own an external request; never evict it here.
    for other in larm-image-qwen21.service larm-image-flux3.service larm-music-ace-step.service larm-mesh-trellis2.service larm-audio-stable.service; do
      if [[ "${other}" != "${service}" ]] && systemctl is-active --quiet "${other}"; then
        echo "another media worker is active; refusing to evict it" >&2
        exit 1
      fi
    done
    available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
    required_kib="$(( (reserve_gb + 16) * 1024 * 1024 ))"
    if (( available_kib < required_kib )); then
      echo "insufficient available memory for ${variant}: need ${required_kib} KiB including safety floor, have ${available_kib} KiB" >&2
      exit 1
    fi
    startup_seconds="${LARM_MEDIA_START_TIMEOUT_SECONDS:-300}"
    if [[ "${variant}" == image || "${variant}" == image-flux3 ]]; then startup_seconds="${LARM_MEDIA_START_TIMEOUT_SECONDS:-60}"; fi
    deadline=$((SECONDS + startup_seconds))
    if ! timeout "$((startup_seconds + 1))" systemctl start "${service}"; then
      stop_worker "${service}"
      exit 1
    fi
    if [[ "${variant}" == music ]] && ! ready >/dev/null 2>&1; then
      until curl -fsS --max-time 3 "${health}" >/dev/null 2>&1; do
        if ! worker_alive; then stop_worker "${service}"; exit 1; fi
        if (( SECONDS >= deadline )); then stop_worker "${service}"; exit 1; fi
        sleep 1
      done
      # Eager startup may have loaded the model while the listener was binding.
      # Initialize only a worker that still reports an unloaded model.
      if ! ready >/dev/null 2>&1; then
        if ! curl -fsS --max-time 240 -H 'content-type: application/json' \
          -d '{"model":"acestep-v15-turbo","init_llm":false}' http://127.0.0.1:8090/v1/init \
          | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("code",200)==200 else 1)'; then
          stop_worker "${service}"
          exit 1
        fi
      fi
    fi
    while true; do
      if ! worker_alive; then stop_worker "${service}"; exit 1; fi
      if ready >/dev/null 2>&1; then break; fi
      if (( SECONDS >= deadline )); then
        echo "${variant} variant did not become healthy" >&2
        stop_worker "${service}"
        exit 1
      fi
      sleep 1
    done
    ;;
  *) echo "usage: $0 status|start|stop music|image|image-flux3|mesh|stable-audio" >&2; exit 2 ;;
esac
