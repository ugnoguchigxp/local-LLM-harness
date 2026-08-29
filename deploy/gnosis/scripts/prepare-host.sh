#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

operator="ugnoguchi"
lan_cidr="${LAN_CIDR:-192.168.0.0/24}"

if ! id "${operator}" >/dev/null 2>&1; then
  echo "Required service account does not exist: ${operator}" >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git curl wget jq htop btop tmux \
  build-essential cmake ninja-build \
  python3 python3-pip pipx \
  ca-certificates gnupg openssl polkitd ufw

systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
usermod -aG render,video "${operator}"

install -d -o "${operator}" -g "${operator}" \
  /srv/ai/models /srv/ai/apps /srv/ai/cache /srv/ai/logs \
  /srv/ai/models/qwen38-worker \
  /srv/ai/models/qwen-tts \
  /srv/ai/models/.larm-staging /srv/ai/models/.larm-rollback \
  /var/lib/larm

ufw default deny incoming
ufw default allow outgoing
ufw allow from "${lan_cidr}" to any port 22 proto tcp

echo "Host prerequisites are prepared. Review 'ufw status' before running 'ufw enable'."
echo "Provider ports are loopback-only; existing legacy LAN rules require reviewed convergence."
echo "This script intentionally does not enable UFW, remove existing rules, configure ROCm/TTM, or reboot."
