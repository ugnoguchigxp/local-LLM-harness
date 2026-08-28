#!/usr/bin/env bash
set -euo pipefail

services=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  voicevox-tts.service
  larm-daemon.service
)

ports=(8080 8081 8083 8084 9810)
failed=0

echo "GPU"
if ! rocminfo 2>/dev/null | grep gfx1151 >/dev/null; then
  echo "gfx1151 not found"
  failed=1
else
  echo "gfx1151 detected"
fi
amd-smi list || failed=1

echo "Services"
for service in "${services[@]}"; do
  if systemctl is-active --quiet "${service}"; then
    printf '%-32s active\n' "${service}"
  else
    printf '%-32s inactive\n' "${service}"
    failed=1
  fi
done

if systemctl is-active --quiet qwen-tts.service; then
  printf '%-32s active (preferred)\n' qwen-tts.service
  if ! curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:8082/health" >/dev/null; then
    echo ":8082 unhealthy"
    failed=1
  fi
else
  printf '%-32s cold (preferred)\n' qwen-tts.service
fi

echo "Health endpoints"
for port in "${ports[@]}"; do
  if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null; then
    printf ':%-5s healthy\n' "${port}"
  else
    printf ':%-5s unhealthy\n' "${port}"
    failed=1
  fi
done

echo "Memory"
if command -v amd-ttm >/dev/null; then
  amd-ttm
elif [[ -x /home/ugnoguchi/.local/bin/amd-ttm ]]; then
  /home/ugnoguchi/.local/bin/amd-ttm
fi
free -h

exit "${failed}"
