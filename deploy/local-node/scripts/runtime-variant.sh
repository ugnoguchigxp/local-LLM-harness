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

case "${action}" in
  status)
    systemctl show "${service}" --property=ActiveState,SubState --no-pager
    ;;
  stop)
    systemctl stop "${service}"
    ;;
  start)
    available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
    required_kib="$(( (reserve_gb + 16) * 1024 * 1024 ))"
    if (( available_kib < required_kib )); then
      echo "insufficient available memory for ${variant}: need ${required_kib} KiB including safety floor, have ${available_kib} KiB" >&2
      exit 1
    fi
    systemctl stop "${other}" 2>/dev/null || true
    systemctl start "${service}"
    deadline=$((SECONDS + 300))
    until curl -fsS --max-time 3 "${health}" >/dev/null 2>&1; do
      if (( SECONDS >= deadline )); then
        echo "${variant} variant did not become healthy" >&2
        exit 1
      fi
      sleep 1
    done
    ;;
  *) echo "usage: $0 status|start|stop music|image" >&2; exit 2 ;;
esac
