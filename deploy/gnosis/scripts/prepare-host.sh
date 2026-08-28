#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

operator="${SUDO_USER:-ugnoguchi}"
lan_cidr="${LAN_CIDR:-192.168.0.0/24}"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git curl wget jq htop btop tmux \
  build-essential cmake ninja-build \
  python3 python3-pip pipx \
  ca-certificates gnupg ufw

systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
usermod -aG render,video "${operator}"

install -d -o "${operator}" -g "${operator}" \
  /srv/ai/models /srv/ai/apps /srv/ai/cache /srv/ai/logs

ufw default deny incoming
ufw default allow outgoing
for port in 22 8080 8081 8082 8083 8084; do
  ufw allow from "${lan_cidr}" to any port "${port}" proto tcp
done

echo "Host prerequisites are prepared. Review 'ufw status' before running 'ufw enable'."
echo "This script intentionally does not enable UFW, configure ROCm/TTM, or reboot."
