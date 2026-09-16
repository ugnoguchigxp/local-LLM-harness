#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
installer="${repo_root}/deploy/local-node/scripts/install-services.sh"
test_root="$(mktemp -d /tmp/larm-install-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
gateway_root="${test_root}-gateway"
invalid_root="${test_root}-invalid"
trap 'rm -rf -- "${test_root}" "${gateway_root}" "${invalid_root}"; rm -f -- "${symlinked_root}"' EXIT

run_installer() {
  LARM_INSTALL_TEST_MODE=1 \
    LARM_INSTALL_ROOT="${test_root}" \
    bash "${installer}" >/dev/null
}

if LARM_INSTALL_TEST_MODE=1 bash "${installer}" >/dev/null 2>&1; then
  echo "installer allowed test mode without an isolated root" >&2
  exit 1
fi

if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${test_root}" \
  LARM_INSTALL_SCOPE=invalid bash "${installer}" >/dev/null 2>&1; then
  echo "installer accepted an invalid installation scope" >&2
  exit 1
fi

ln -s / "${symlinked_root}"
if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${symlinked_root}" \
  bash "${installer}" >/dev/null 2>&1; then
  echo "installer allowed a symlinked test root" >&2
  exit 1
fi
rm "${symlinked_root}"

mkdir -p "${invalid_root}/etc/larm"
printf 'invalid\n' >"${invalid_root}/etc/larm/inference-audit.key"
if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${invalid_root}" \
  LARM_INSTALL_SCOPE=gateway bash "${installer}" >/dev/null 2>&1; then
  echo "installer accepted an invalid audit key" >&2
  exit 1
fi
[[ ! -e "${invalid_root}/etc/systemd/system/larm-daemon.service" ]]
rm "${invalid_root}/etc/larm/inference-audit.key"
printf 'LARM_API_TOKEN=must-not-reach-prune\n' >"${invalid_root}/etc/larm/inference-audit.env"
if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${invalid_root}" \
  LARM_INSTALL_SCOPE=gateway bash "${installer}" >/dev/null 2>&1; then
  echo "installer accepted a credential in the audit configuration" >&2
  exit 1
fi
[[ ! -e "${invalid_root}/etc/systemd/system/larm-daemon.service" ]]

mkdir -p "${test_root}/etc/systemd/system"
printf '[Unit]\nDescription=obsolete native Provider\n' \
  >"${test_root}/etc/systemd/system/larm-native-qwen-provider.service"
mkdir -p "${test_root}/usr/local/libexec/larm"
printf '#!/usr/bin/env bash\n' \
  >"${test_root}/usr/local/libexec/larm/retire-legacy-websocket"
run_installer
credential="${test_root}/etc/larm/larm.env"
initial_credential="$(<"${credential}")"
grep -Eq '^LARM_MANAGEMENT_TOKEN=[a-f0-9]{64}$' "${credential}"
grep -Eq '^LARM_API_TOKEN=[a-f0-9]{64}$' "${credential}"
grep -Eq '^LARM_CONNECTION_SIGNING_KEY=[A-Za-z0-9_-]{43}$' "${credential}"
[[ "$(wc -l <"${credential}")" -eq 3 ]]
[[ "$(stat -c '%a' "${credential}")" == "640" ]]
audit_key="${test_root}/etc/larm/inference-audit.key"
grep -Eq '^[A-Za-z0-9_-]{43}$' "${audit_key}"
[[ "$(stat -c '%a' "${audit_key}")" == "640" ]]
initial_audit_key="$(<"${audit_key}")"
audit_config="${test_root}/etc/larm/inference-audit.env"
grep -Fqx 'LARM_INFERENCE_AUDIT_MODE=full-required' "${audit_config}"
grep -Fqx 'LARM_INFERENCE_AUDIT_RETENTION_SECONDS=604800' "${audit_config}"
[[ "$(stat -c '%a' "${audit_config}")" == "640" ]]
initial_audit_config="$(<"${audit_config}")"

run_installer
[[ "$(<"${credential}")" == "${initial_credential}" ]]
[[ "$(<"${audit_key}")" == "${initial_audit_key}" ]]
[[ "$(<"${audit_config}")" == "${initial_audit_config}" ]]

for unit in "${repo_root}"/deploy/local-node/systemd/*.service \
  "${repo_root}"/deploy/local-node/systemd/*.timer \
  "${repo_root}"/deploy/local-node/systemd/*.path; do
  cmp --silent "${unit}" "${test_root}/etc/systemd/system/$(basename "${unit}")"
done
cmp --silent \
  "${repo_root}/deploy/local-node/polkit/50-larm-runtime-control.rules" \
  "${test_root}/etc/polkit-1/rules.d/50-larm-runtime-control.rules"

systemctl_log="${test_root}/var/lib/larm/install-systemctl.log"
grep -F "enable llama-server.service llama-swap-worker.service qwen-asr.service whisper-asr.service voicevox-tts.service larm-daemon.service" \
  "${systemctl_log}" >/dev/null
grep -F "disable qwen-tts.service larm-embedding.service" "${systemctl_log}" >/dev/null
[[ -d "${test_root}/srv/ai/models/qwen-tts" ]]
[[ -d "${test_root}/srv/ai/models/multilingual-e5-small-onnx-qint8" ]]
[[ -d "${test_root}/srv/ai/models/qwen36-35b" ]]
[[ -d "${test_root}/srv/ai/models/ornith15-35b" ]]
[[ "$(stat -c '%a' "${test_root}/var/lib/larm/inference-audit")" == "700" ]]
[[ "$(stat -c '%a' "${test_root}/srv/ai/context-sources")" == "700" ]]
[[ -f "${test_root}/etc/systemd/system/larm-inference-audit-prune.timer" ]]
[[ -f "${test_root}/etc/systemd/system/larm-release-activator.path" ]]
[[ -f "${test_root}/etc/systemd/system/larm-http-provider-monitor.timer" ]]
[[ -x "${test_root}/usr/local/libexec/larm/activate-larm-release" ]]
[[ -x "${test_root}/usr/local/libexec/larm/record-larm-release-gate" ]]
[[ -x "${test_root}/usr/local/libexec/larm/rollback-larm-release" ]]
[[ ! -e "${test_root}/usr/local/libexec/larm/retire-legacy-websocket" ]]
[[ ! -e "${test_root}/etc/systemd/system/larm-native-qwen-provider.service" ]]
grep -F "disable --now larm-native-qwen-provider.service" "${systemctl_log}" >/dev/null
[[ "$(stat -c '%a' "${test_root}/var/lib/larm/release-builder/signing-key.pem")" == "600" ]]
[[ "$(stat -c '%a' "${test_root}/etc/larm/release-signing.pub")" == "644" ]]
openssl pkey -pubin -in "${test_root}/etc/larm/release-signing.pub" -noout >/dev/null
grep -F "ReadWritePaths=/srv/ai/cache /srv/ai/context-sources /srv/ai/logs /srv/ai/models /var/lib/larm" \
  "${test_root}/etc/systemd/system/larm-daemon.service" >/dev/null
grep -F "Environment=LARM_CONNECTION_READY_TIMEOUT_SECONDS=300" \
  "${test_root}/etc/systemd/system/larm-daemon.service" >/dev/null
grep -F "ReadWritePaths=/srv/ai/cache /srv/ai/logs" \
  "${test_root}/etc/systemd/system/llama-swap-worker.service" >/dev/null

mkdir -p "${gateway_root}/etc/systemd/system"
printf '[Unit]\nDescription=obsolete native Provider\n' \
  >"${gateway_root}/etc/systemd/system/larm-native-qwen-provider.service"
LARM_INSTALL_TEST_MODE=1 \
  LARM_INSTALL_ROOT="${gateway_root}" \
  LARM_INSTALL_SCOPE=gateway \
  bash "${installer}" >/dev/null
[[ -f "${gateway_root}/etc/systemd/system/larm-daemon.service" ]]
[[ -f "${gateway_root}/etc/systemd/system/larm-inference-audit-prune.service" ]]
[[ -f "${gateway_root}/etc/systemd/system/larm-inference-audit-prune.timer" ]]
[[ -f "${gateway_root}/etc/systemd/system/larm-release-activator.path" ]]
[[ -f "${gateway_root}/etc/systemd/system/larm-http-provider-monitor.timer" ]]
for unit in llama-server.service llama-swap-worker.service qwen-asr.service whisper-asr.service qwen-tts.service larm-embedding.service \
  voicevox-tts.service; do
  [[ ! -e "${gateway_root}/etc/systemd/system/${unit}" ]]
done
grep -F "enable larm-daemon.service" \
  "${gateway_root}/var/lib/larm/install-systemctl.log" >/dev/null
if grep -Eq 'llama-server|llama-swap-worker|qwen-asr|whisper-asr|qwen-tts|voicevox-tts' \
  "${gateway_root}/var/lib/larm/install-systemctl.log"; then
  echo "gateway scope changed a Provider unit" >&2
  exit 1
fi
[[ ! -e "${gateway_root}/etc/systemd/system/larm-native-qwen-provider.service" ]]
grep -F "disable --now larm-native-qwen-provider.service" \
  "${gateway_root}/var/lib/larm/install-systemctl.log" >/dev/null
[[ ! -e "${gateway_root}/srv/ai/models/qwen38-worker" ]]
[[ ! -e "${gateway_root}/srv/ai/models/qwen36-35b" ]]
[[ ! -e "${gateway_root}/srv/ai/models/ornith15-35b" ]]
[[ ! -e "${gateway_root}/srv/ai/models/qwen-tts" ]]
[[ -d "${gateway_root}/srv/ai/models/.larm-staging" ]]
[[ -d "${gateway_root}/srv/ai/models/.larm-rollback" ]]
[[ "$(stat -c '%a' "${gateway_root}/srv/ai/context-sources")" == "700" ]]
[[ -f "${gateway_root}/etc/larm/larm.env" ]]
[[ -f "${gateway_root}/etc/larm/inference-audit.env" ]]
grep -Eq '^[A-Za-z0-9_-]{43}$' "${gateway_root}/etc/larm/inference-audit.key"
[[ "$(stat -c '%a' "${gateway_root}/var/lib/larm/inference-audit")" == "700" ]]
[[ -f "${gateway_root}/etc/polkit-1/rules.d/50-larm-runtime-control.rules" ]]

ln "${gateway_root}/etc/larm/inference-audit.key" "${gateway_root}/audit-key-hardlink"
if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${gateway_root}" \
  LARM_INSTALL_SCOPE=gateway bash "${installer}" >/dev/null 2>&1; then
  echo "installer accepted a hard-linked audit key" >&2
  exit 1
fi

credential_target="${test_root}/credential-target"
printf 'unchanged\n' >"${credential_target}"
rm "${credential}"
ln -s "${credential_target}" "${credential}"
unit_before="$(sha256sum "${test_root}/etc/systemd/system/larm-daemon.service" | awk '{print $1}')"
if run_installer 2>/dev/null; then
  echo "installer accepted a symlinked credential" >&2
  exit 1
fi
[[ "$(<"${credential_target}")" == "unchanged" ]]
[[ "$(sha256sum "${test_root}/etc/systemd/system/larm-daemon.service" | awk '{print $1}')" == "${unit_before}" ]]

rm "${credential}"
printf '%s\n' "${initial_credential}" >"${credential}"
unit_target="${test_root}/etc/systemd/system/llama-server.service"
grep -F -- "--ubatch 256" "${unit_target}" >/dev/null
unit_redirect="${test_root}/unit-redirect"
printf 'unchanged unit target\n' >"${unit_redirect}"
rm "${unit_target}"
ln -s "${unit_redirect}" "${unit_target}"
if run_installer 2>/dev/null; then
  echo "installer accepted a symlinked unit target" >&2
  exit 1
fi
[[ "$(<"${unit_redirect}")" == "unchanged unit target" ]]

rm "${unit_target}"
printf '[Unit]\n' >"${unit_target}"
polkit_redirect="${test_root}/polkit-redirect"
mkdir "${polkit_redirect}"
rm -rf "${test_root}/etc/polkit-1/rules.d"
ln -s "${polkit_redirect}" "${test_root}/etc/polkit-1/rules.d"
if run_installer 2>/dev/null; then
  echo "installer accepted a symlinked installation directory" >&2
  exit 1
fi
[[ ! -e "${polkit_redirect}/50-larm-runtime-control.rules" ]]

echo "deployment installer tests passed"
