#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-status}"
variant="${2:-}"
case "${variant}" in
  music) service=larm-music-ace-step.service; other=larm-image-qwen21.service; health=http://127.0.0.1:8090/health; reserve_gb=18 ;;
  image) service=larm-image-qwen21.service; other=larm-music-ace-step.service; health=http://127.0.0.1:8091/health; reserve_gb=34 ;;
  *) echo "usage: $0 status|start|stop music|image" >&2; exit 2 ;;
esac

ready() {
  local response
  response="$(curl -fsS --max-time 3 "${health}")" || return 1
  python3 -c 'import json,sys; v=json.load(sys.stdin); d=v.get("data",v); sys.exit(0 if (d.get("loaded") is True if sys.argv[1]=="image" else d.get("models_initialized") is True) else 1)' "${variant}" <<<"${response}"
}

case "${action}" in
  status)
    systemctl show "${service}" --property=ActiveState,SubState --no-pager
    ;;
  stop)
    timeout 75 systemctl stop "${service}"
    if systemctl is-active --quiet "${service}"; then
      echo "${variant} worker remained active after stop" >&2
      exit 1
    fi
    ;;
  start)
    if systemctl is-active --quiet "${service}" && ready >/dev/null 2>&1; then
      exit 0
    fi
    # A different idle variant owns memory that this request is replacing.
    # Wait for its shutdown before measuring the available headroom.
    systemctl stop "${other}"
    available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
    required_kib="$(( (reserve_gb + 16) * 1024 * 1024 ))"
    if (( available_kib < required_kib )); then
      echo "insufficient available memory for ${variant}: need ${required_kib} KiB including safety floor, have ${available_kib} KiB" >&2
      exit 1
    fi
    if ! timeout 310 systemctl start "${service}"; then
      systemctl stop "${service}"
      exit 1
    fi
    deadline=$((SECONDS + ${LARM_MEDIA_START_TIMEOUT_SECONDS:-300}))
    if [[ "${variant}" == music ]] && ! ready >/dev/null 2>&1; then
      until curl -fsS --max-time 3 "${health}" >/dev/null 2>&1; do
        if (( SECONDS >= deadline )); then systemctl stop "${service}"; exit 1; fi
        sleep 1
      done
      if ! curl -fsS --max-time 240 -H 'content-type: application/json' \
        -d '{"model":"acestep-v15-turbo","init_llm":false}' http://127.0.0.1:8090/v1/init \
        | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("code",200)==200 else 1)'; then
        systemctl stop "${service}"
        exit 1
      fi
    fi
    until ready >/dev/null 2>&1; do
      if (( SECONDS >= deadline )); then
        echo "${variant} variant did not become healthy" >&2
        systemctl stop "${service}"
        exit 1
      fi
      sleep 1
    done
    ;;
  *) echo "usage: $0 status|start|stop music|image" >&2; exit 2 ;;
esac
