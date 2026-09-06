#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_source="${repo_root}/deploy/local-node/systemd"
test_mode="${LARM_INSTALL_TEST_MODE:-0}"
install_root="${LARM_INSTALL_ROOT:-}"
install_scope="${LARM_INSTALL_SCOPE:-all}"
operator="ugnoguchi"

if [[ "${install_scope}" != "all" && "${install_scope}" != "gateway" ]]; then
  echo "LARM_INSTALL_SCOPE must be all or gateway" >&2
  exit 1
fi

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
audit_config_path="${credential_dir}/inference-audit.env"
audit_key_path="${credential_dir}/inference-audit.key"
polkit_dir="$(target_path /etc/polkit-1/rules.d)"
state_dir="$(target_path /var/lib/larm)"
audit_dir="$(target_path /var/lib/larm/inference-audit)"
staging_dir="$(target_path /srv/ai/models/.larm-staging)"
rollback_dir="$(target_path /srv/ai/models/.larm-rollback)"
worker_dir="$(target_path /srv/ai/models/qwen38-worker)"
worker_35b_dir="$(target_path /srv/ai/models/qwen36-35b)"
ornith_35b_dir="$(target_path /srv/ai/models/ornith15-35b)"
tts_dir="$(target_path /srv/ai/models/qwen-tts)"
candidate_dir="$(target_path /srv/ai/apps/larm-candidates)"
release_dir="$(target_path /srv/ai/apps/larm-releases)"
release_inbox_dir="$(target_path /var/lib/larm/release-inbox)"
release_controller_dir="$(target_path /var/lib/larm/release-controller)"
release_builder_dir="$(target_path /var/lib/larm/release-builder)"
release_private_key="${release_builder_dir}/signing-key.pem"
release_public_key="${credential_dir}/release-signing.pub"
libexec_dir="$(target_path /usr/local/libexec/larm)"
release_activator="${libexec_dir}/activate-larm-release"
release_gate_recorder="${libexec_dir}/record-larm-release-gate"
release_rollback="${libexec_dir}/rollback-larm-release"

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

if [[ "${install_scope}" == "gateway" ]]; then
  units=(larm-daemon.service larm-inference-audit-prune.service larm-inference-audit-prune.timer larm-release-activator.service larm-release-activator.path larm-http-provider-monitor.service larm-http-provider-monitor.timer)
  enabled_units=(larm-daemon.service larm-inference-audit-prune.timer larm-release-activator.path larm-http-provider-monitor.timer)
  data_directories=("${staging_dir}" "${rollback_dir}" "${state_dir}" "${audit_dir}" "${candidate_dir}" "${release_inbox_dir}" "${release_builder_dir}")
else
  units=(
    llama-server.service
    larm-native-qwen-provider.service
    llama-swap-worker.service
    qwen-asr.service
    whisper-asr.service
    qwen-tts.service
    voicevox-tts.service
    larm-daemon.service
    larm-inference-audit-prune.service
    larm-inference-audit-prune.timer
    larm-release-activator.service
    larm-release-activator.path
    larm-http-provider-monitor.service
    larm-http-provider-monitor.timer
  )
  enabled_units=(
    llama-server.service
    larm-native-qwen-provider.service
    llama-swap-worker.service
    qwen-asr.service
    whisper-asr.service
    voicevox-tts.service
    larm-daemon.service
    larm-inference-audit-prune.timer
    larm-release-activator.path
    larm-http-provider-monitor.timer
  )
  data_directories=(
    "${worker_dir}"
    "${worker_35b_dir}"
    "${ornith_35b_dir}"
    "${tts_dir}"
    "${staging_dir}"
    "${rollback_dir}"
    "${state_dir}"
    "${audit_dir}"
    "${candidate_dir}"
    "${release_inbox_dir}"
    "${release_builder_dir}"
  )
fi

safe_install_target() {
  local path="$1" description="$2"
  if [[ -L "${path}" || ( -e "${path}" && ! -f "${path}" ) ]]; then
    echo "Refusing unsafe ${description}: ${path}" >&2
    exit 1
  fi
  if [[ -f "${path}" && "$(stat -c '%h' -- "${path}")" -ne 1 ]]; then
    echo "Refusing hard-linked ${description}: ${path}" >&2
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

validate_audit_config() {
  awk '
    BEGIN {
      allowed["LARM_INFERENCE_AUDIT_MODE"] = "mode"
      allowed["LARM_INFERENCE_AUDIT_ROOT"] = "path"
      allowed["LARM_INFERENCE_AUDIT_KEY_FILE"] = "path"
      allowed["LARM_INFERENCE_AUDIT_RETENTION_SECONDS"] = "number"
      allowed["LARM_INFERENCE_AUDIT_MAX_BYTES"] = "number"
      allowed["LARM_INFERENCE_AUDIT_MIN_FREE_BYTES"] = "number"
      allowed["LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES"] = "number"
      allowed["LARM_INFERENCE_AUDIT_MATERIALIZATION_TIMEOUT_SECONDS"] = "number"
    }
    {
      separator = index($0, "=")
      if (separator < 2) exit 1
      name = substr($0, 1, separator - 1)
      value = substr($0, separator + 1)
      if (!(name in allowed) || seen[name]++) exit 1
      if (allowed[name] == "mode" && value !~ /^(off|metadata|full-required)$/) exit 1
      if (allowed[name] == "path" && value !~ /^\/[A-Za-z0-9._\/-]+$/) exit 1
      if (allowed[name] == "number" && value !~ /^[0-9]+$/) exit 1
    }
  ' "$1"
}

if [[ "${test_mode}" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

if [[ "${test_mode}" != "1" ]] && ! id "${operator}" >/dev/null 2>&1; then
  echo "Required service account does not exist: ${operator}" >&2
  exit 1
fi

for directory in "${unit_target}" "${credential_dir}" "${polkit_dir}" \
  "${libexec_dir}" "${release_dir}" "${release_controller_dir}" "${data_directories[@]}"; do
  safe_directory_path "${directory}" "installation directory"
done

for unit in "${units[@]}"; do
  safe_install_target "${unit_target}/${unit}" "unit target"
done
safe_install_target "${polkit_dir}/50-larm-runtime-control.rules" "polkit target"
safe_install_target "${credential_path}" "credential target"
safe_install_target "${audit_config_path}" "audit configuration target"
safe_install_target "${audit_key_path}" "audit key target"
safe_install_target "${release_private_key}" "release private key target"
safe_install_target "${release_public_key}" "release public key target"
safe_install_target "${release_activator}" "release activator target"
safe_install_target "${release_gate_recorder}" "release gate recorder target"
safe_install_target "${release_rollback}" "release rollback target"
if [[ -e "${audit_config_path}" ]] && {
  [[ "$(stat -c '%s' -- "${audit_config_path}")" -gt 8192 ]] \
    || ! validate_audit_config "${audit_config_path}";
}; then
  echo "Refusing invalid inference audit configuration: ${audit_config_path}" >&2
  exit 1
fi
if [[ -e "${audit_key_path}" ]] && {
  [[ "$(stat -c '%s' -- "${audit_key_path}")" -ne 44 ]] \
    || ! grep -Eq '^[A-Za-z0-9_-]{43}$' "${audit_key_path}";
}; then
  echo "Refusing invalid inference audit key: ${audit_key_path}" >&2
  exit 1
fi

install -d -o "${data_owner}" -g "${data_group}" "${data_directories[@]}"
install -d -o "${data_owner}" -g "${data_group}" -m 0700 "${audit_dir}"
install -d -o "${data_owner}" -g "${data_group}" -m 0750 "${candidate_dir}"
install -d -o "${data_owner}" -g "${data_group}" -m 0700 "${release_inbox_dir}" "${release_builder_dir}"
install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${release_dir}" "${libexec_dir}"
install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${release_controller_dir}"
install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${unit_target}"

for unit in "${units[@]}"; do
  install -o "${system_owner}" -g "${system_group}" -m 0644 \
    "${unit_source}/${unit}" "${unit_target}/${unit}"
done
install -o "${system_owner}" -g "${system_group}" -m 0755 \
  "${repo_root}/deploy/local-node/scripts/activate-larm-release.sh" "${release_activator}"
install -o "${system_owner}" -g "${system_group}" -m 0755 \
  "${repo_root}/deploy/local-node/scripts/record-larm-release-gate.sh" "${release_gate_recorder}"
install -o "${system_owner}" -g "${system_group}" -m 0755 \
  "${repo_root}/deploy/local-node/scripts/rollback-larm-release.sh" "${release_rollback}"

install -d -o "${system_owner}" -g "${system_group}" -m 0755 "${polkit_dir}"
install -o "${system_owner}" -g "${system_group}" -m 0644 \
  "${repo_root}/deploy/local-node/polkit/50-larm-runtime-control.rules" \
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

if [[ ! -e "${audit_config_path}" ]]; then
  umask 0077
  {
    printf 'LARM_INFERENCE_AUDIT_MODE=full-required\n'
    printf 'LARM_INFERENCE_AUDIT_ROOT=/var/lib/larm/inference-audit\n'
    printf 'LARM_INFERENCE_AUDIT_KEY_FILE=/etc/larm/inference-audit.key\n'
    printf 'LARM_INFERENCE_AUDIT_RETENTION_SECONDS=604800\n'
    printf 'LARM_INFERENCE_AUDIT_MAX_BYTES=10737418240\n'
    printf 'LARM_INFERENCE_AUDIT_MIN_FREE_BYTES=21474836480\n'
    printf 'LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES=16777216\n'
    printf 'LARM_INFERENCE_AUDIT_MATERIALIZATION_TIMEOUT_SECONDS=30\n'
  } >"${audit_config_path}"
fi
if ! validate_audit_config "${audit_config_path}"; then
  echo "Refusing invalid inference audit configuration: ${audit_config_path}" >&2
  exit 1
fi
chown "${credential_owner}":"${credential_group}" "${audit_config_path}"
chmod 0640 "${audit_config_path}"

if [[ ! -e "${audit_key_path}" ]]; then
  audit_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  umask 0077
  printf '%s\n' "${audit_key}" >"${audit_key_path}"
fi
if [[ "$(stat -c '%s' -- "${audit_key_path}")" -ne 44 ]] \
  || ! grep -Eq '^[A-Za-z0-9_-]{43}$' "${audit_key_path}"; then
  echo "Refusing invalid inference audit key: ${audit_key_path}" >&2
  exit 1
fi
chown "${credential_owner}":"${credential_group}" "${audit_key_path}"
chmod 0640 "${audit_key_path}"

if [[ ! -e "${release_private_key}" ]]; then
  umask 0077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${release_private_key}" >/dev/null 2>&1
fi
openssl pkey -in "${release_private_key}" -check -noout >/dev/null 2>&1 \
  || { echo "Refusing invalid release signing key: ${release_private_key}" >&2; exit 1; }
chown "${data_owner}":"${data_group}" "${release_private_key}"
chmod 0600 "${release_private_key}"
public_update="$(mktemp "${credential_dir}/.release-signing.pub.XXXXXX")"
openssl pkey -in "${release_private_key}" -pubout -out "${public_update}" >/dev/null 2>&1
chown "${system_owner}":"${system_group}" "${public_update}"
chmod 0644 "${public_update}"
mv -fT -- "${public_update}" "${release_public_key}"

systemctl_run daemon-reload
systemctl_run enable "${enabled_units[@]}"
if [[ "${install_scope}" == "all" ]]; then
  systemctl_run disable qwen-tts.service
fi

if [[ "${install_scope}" == "gateway" ]]; then
  echo "LARM Gateway unit enabled; existing Provider units and their enablement were not changed."
else
  echo "Resident/control units enabled; preferred qwen-tts.service left disabled for on-demand use."
fi
echo "This script intentionally does not reboot or restart services."
echo "Apply a changed unit explicitly, for example: systemctl restart llama-swap-worker.service"
echo "LARM API, Agent Connection, and management credentials are stored in ${credential_path}."
echo "Inference audit settings are stored in ${audit_config_path}; the encryption key remains separate."
