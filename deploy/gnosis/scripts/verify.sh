#!/usr/bin/env bash
set -euo pipefail

services=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  qwen-tts.service
  voicevox-tts.service
)

ports=(8080 8081 8082 8083 8084)
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
