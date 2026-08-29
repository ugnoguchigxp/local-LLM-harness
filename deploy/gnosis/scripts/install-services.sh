#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_source="${repo_root}/deploy/gnosis/systemd"
test_mode="${LARM_INSTALL_TEST_MODE:-0}"
install_root="${LARM_INSTALL_ROOT:-}"
operator="ugnoguchi"

if [[ "${test_mode}" == "1" && -z "${install_root}" ]]; then
  echo "LARM_INSTALL_ROOT is required in test mode" >&2
  exit 1
fi
if [[ -n "${install_root}" ]]; then
  if [[ "${test_mode}" != "1" || "${install_root}" != /* || "${install_root}" == "/" ]]; then
    echo "LARM_INSTALL_ROOT is only allowed as an absolute non-root path in test mode" >&2
    exit 1
  fi
  if [[ ! -d "${install_root}" || -L "${install_root}" ]]; then
    echo "LARM_INSTALL_ROOT must be an existing, real directory" >&2
    exit 1
  fi
  install_root="$(realpath -e -- "${install_root}")"
  if [[ "${install_root}" == "/" ]]; then
    echo "LARM_INSTALL_ROOT must not resolve to the filesystem root" >&2
    exit 1
  fi
  install_root="${install_root%/}"
fi

target_path() {
  printf '%s%s' "${install_root}" "$1"
}

unit_target="$(target_path /etc/systemd/system)"
credential_dir="$(target_path /etc/larm)"
credential_path="${credential_dir}/larm.env"
polkit_dir="$(target_path /etc/polkit-1/rules.d)"
state_dir="$(target_path /var/lib/larm)"
staging_dir="$(target_path /srv/ai/models/.larm-staging)"
rollback_dir="$(target_path /srv/ai/models/.larm-rollback)"
worker_dir="$(target_path /srv/ai/models/qwen38-worker)"
worker_35b_dir="$(target_path /srv/ai/models/qwen36-35b)"
ornith_35b_dir="$(target_path /srv/ai/models/ornith15-35b)"
tts_dir="$(target_path /srv/ai/models/qwen-tts)"

if [[ "${test_mode}" == "1" ]]; then
  data_owner="$(id -un)"
  data_group="$(id -gn)"
  system_owner="${data_owner}"
  system_group="${data_group}"
  credential_owner="${data_owner}"
  credential_group="${data_group}"
else
  data_owner="${operator}"
  data_group="${operator}"
  system_owner="root"
  system_group="root"
  credential_owner="root"
  credential_group="${operator}"
fi

systemctl_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf '%s\n' "$*" >>"$(target_path /var/lib/larm/install-systemctl.log)"
  else
    systemctl "$@"
  fi
}

units=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  qwen-tts.service
  voicevox-tts.service
  larm-daemon.service
)

enabled_units=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  voicevox-tts.service
  larm-daemon.service
)

safe_install_target() {
  local path="$1" description="$2"
  if [[ -L "${path}" || ( -e "${path}" && ! -f "${path}" ) ]]; then
    echo "Refusing unsafe ${description}: ${path}" >&2
    exit 1
  fi
}

safe_directory_path() {
  local path="$1" description="$2"
  if [[ "$(realpath -sm -- "${path}")" != "$(realpath -m -- "${path}")" ]]; then
    echo "Refusing symlinked ${description}: ${path}" >&2
    exit 1
  fi
}

if [[ "${test_mode}" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

if [[ "${test_mode}" != "1" ]] && ! id "${operator}" >/dev/null 2>&1; then
  echo "Required service account does not exist: ${operator}" >&2
  exit 1
fi

for directory in "${unit_target}" "${credential_dir}" "${polkit_dir}" "${state_dir}" \
  "${staging_dir}" "${rollback_dir}" "${worker_dir}" "${worker_35b_dir}" \
  "${ornith_35b_dir}" "${tts_dir}"; do
  safe_directory_path "${directory}" "installation directory"
done

for unit in "${units[@]}"; do
  safe_install_target "${unit_target}/${unit}" "unit target"
done
safe_install_target "${polkit_dir}/50-larm-runtime-control.rules" "polkit target"
safe_install_target "${credential_path}" "credential target"

install -d -o "${data_owner}" -g "${data_group}" \
  "${worker_dir}" \
  "${worker_35b_dir}" \
  "${ornith_35b_dir}" \
  "${tts_dir}" \
  "${staging_dir}" \
  "${rollback_dir}" \
  "${state_dir}"
install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${unit_target}"

for unit in "${units[@]}"; do
  install -o "${system_owner}" -g "${system_group}" -m 0644 \
    "${unit_source}/${unit}" "${unit_target}/${unit}"
done

install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${polkit_dir}"
install -o "${system_owner}" -g "${system_group}" -m 0644 \
  "${repo_root}/deploy/gnosis/polkit/50-larm-runtime-control.rules" \
  "${polkit_dir}/50-larm-runtime-control.rules"

install -d -o "${credential_owner}" -g "${credential_group}" -m 0750 "${credential_dir}"
if [[ ! -e "${credential_path}" ]]; then
  management_token="$(openssl rand -hex 32)"
  api_token="$(openssl rand -hex 32)"
  connection_signing_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  umask 0077
  {
    printf 'LARM_MANAGEMENT_TOKEN=%s\n' "${management_token}"
    printf 'LARM_API_TOKEN=%s\n' "${api_token}"
    printf 'LARM_CONNECTION_SIGNING_KEY=%s\n' "${connection_signing_key}"
  } >"${credential_path}"
else
  credential_update="$(mktemp "${credential_dir}/.larm.env.XXXXXX")"
  cp -- "${credential_path}" "${credential_update}"
  if ! grep -Eq '^LARM_API_TOKEN=.+$' "${credential_update}"; then
    printf 'LARM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"${credential_update}"
  fi
  if ! grep -Eq '^LARM_CONNECTION_SIGNING_KEY=.+$' "${credential_update}"; then
    signing_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
    printf 'LARM_CONNECTION_SIGNING_KEY=%s\n' "${signing_key}" >>"${credential_update}"
  fi
  if ! grep -Eq '^LARM_MANAGEMENT_TOKEN=.+$' "${credential_update}"; then
    printf 'LARM_MANAGEMENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"${credential_update}"
  fi
  chown "${credential_owner}":"${credential_group}" "${credential_update}"
  chmod 0640 "${credential_update}"
  mv -fT -- "${credential_update}" "${credential_path}"
fi
chown "${credential_owner}":"${credential_group}" "${credential_path}"
chmod 0640 "${credential_path}"

systemctl_run daemon-reload
systemctl_run enable "${enabled_units[@]}"
systemctl_run disable qwen-tts.service

echo "Resident/control units enabled; preferred qwen-tts.service left disabled for on-demand use."
echo "This script intentionally does not reboot or restart services."
echo "Apply a changed unit explicitly, for example: systemctl restart llama-swap-worker.service"
echo "LARM API, Agent Connection, and management credentials are stored in ${credential_path}."
