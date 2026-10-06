#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -un) != larm-services ]]; then
  echo 'Run preflight as the dedicated larm-services account.' >&2
  exit 1
fi
exec /usr/bin/python3 /usr/local/libexec/larm-local-service-controller.py preflight
