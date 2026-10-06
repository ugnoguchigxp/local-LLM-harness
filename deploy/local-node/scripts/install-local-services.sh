#!/usr/bin/env bash
set -euo pipefail
# Install fixed control files only. Does not start services or change AI Provider units.
if [[ ${EUID} -ne 0 ]]; then
  echo 'Administrator privileges are required to install the isolated service account and units.' >&2
  exit 1
fi
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
daemon_user=${LARM_LOCAL_SERVICES_DAEMON_USER:-$(awk -F= '/^User=/{print $2; exit}' "$source_root/deploy/local-node/systemd/larm-daemon.service")}
if [[ ! "$daemon_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || ! getent passwd "$daemon_user" >/dev/null; then
  echo 'Configure LARM_LOCAL_SERVICES_DAEMON_USER to the existing LARM daemon account.' >&2
  exit 1
fi
daemon_group=$(id -gn "$daemon_user")
if ! command -v docker >/dev/null || ! command -v newuidmap >/dev/null || ! command -v newgidmap >/dev/null; then
  echo 'Install Docker Engine with rootless extras and uidmap before running this installer.' >&2
  exit 1
fi
if ! getent passwd larm-services >/dev/null; then
  useradd --create-home --home-dir /var/lib/larm-local-services --shell /bin/bash larm-services
fi
service_uid=$(id -u larm-services)
if ! awk -F: '$1 == "larm-services" && $3 >= 65536 { found=1 } END { exit !found }' /etc/subuid ||
   ! awk -F: '$1 == "larm-services" && $3 >= 65536 { found=1 } END { exit !found }' /etc/subgid; then
  echo 'larm-services needs a dedicated non-overlapping subuid/subgid range of at least 65536 IDs.' >&2
  exit 1
fi
install -d -m 0750 -o larm-services -g larm-services /etc/larm-local-services/docling-desk
install -d -m 0700 -o larm-services -g larm-services /etc/larm-local-services/docling-desk/secrets
install -d -m 0755 -o larm-services -g larm-services /var/lib/larm-local-services/observations
install -d -m 0750 -o root -g "$daemon_group" /etc/larm/local-services /etc/larm/local-services/secrets
install -d -m 0700 -o "$daemon_user" -g "$daemon_group" /var/lib/larm/local-services
install -d -m 0755 /usr/local/libexec
install -m 0755 "$source_root/deploy/local-node/local-services/controller.py" /usr/local/libexec/larm-local-service-controller.py
install -m 0644 "$source_root/deploy/local-node/local-services/docling-compose.yaml" /etc/larm-local-services/docling-desk/compose.yaml
install -m 0644 "$source_root/deploy/local-node/systemd/larm-local-service-docling-desk.service" /etc/systemd/system/
install -m 0644 "$source_root/deploy/local-node/systemd/larm-local-service-docling-desk-stop.service" /etc/systemd/system/
install -m 0644 "$source_root/deploy/local-node/systemd/larm-local-service-observe.service" /etc/systemd/system/
install -m 0644 "$source_root/deploy/local-node/systemd/larm-local-service-observe.timer" /etc/systemd/system/
policy_temp=$(mktemp)
trap 'rm -f -- "$policy_temp"' EXIT
sed "s/__LARM_DAEMON_USER__/$daemon_user/g" "$source_root/deploy/local-node/polkit/60-larm-local-service-control.rules" > "$policy_temp"
install -m 0644 "$policy_temp" /etc/polkit-1/rules.d/60-larm-local-service-control.rules
loginctl enable-linger larm-services
systemctl daemon-reload
printf 'Control files installed. Configure the rootless daemon for UID %s, pinned images and secrets, then run preflight. No service has been started.\n' "$service_uid"
