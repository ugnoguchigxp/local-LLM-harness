#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
installer="${repo_root}/deploy/gnosis/scripts/install-services.sh"
test_root="$(mktemp -d /tmp/larm-install-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
trap 'rm -rf -- "${test_root}"; rm -f -- "${symlinked_root}"' EXIT

run_installer() {
  LARM_INSTALL_TEST_MODE=1 \
    LARM_INSTALL_ROOT="${test_root}" \
    bash "${installer}" >/dev/null
}

if LARM_INSTALL_TEST_MODE=1 bash "${installer}" >/dev/null 2>&1; then
  echo "installer allowed test mode without an isolated root" >&2
  exit 1
fi

ln -s / "${symlinked_root}"
if LARM_INSTALL_TEST_MODE=1 LARM_INSTALL_ROOT="${symlinked_root}" \
  bash "${installer}" >/dev/null 2>&1; then
  echo "installer allowed a symlinked test root" >&2
  exit 1
fi
rm "${symlinked_root}"

run_installer
credential="${test_root}/etc/larm/larm.env"
initial_credential="$(<"${credential}")"
[[ "${initial_credential}" =~ ^LARM_MANAGEMENT_TOKEN=[a-f0-9]{64}$ ]]
[[ "$(stat -c '%a' "${credential}")" == "640" ]]

run_installer
[[ "$(<"${credential}")" == "${initial_credential}" ]]

for unit in "${repo_root}"/deploy/gnosis/systemd/*.service; do
  cmp --silent "${unit}" "${test_root}/etc/systemd/system/$(basename "${unit}")"
done
cmp --silent \
  "${repo_root}/deploy/gnosis/polkit/50-larm-runtime-control.rules" \
  "${test_root}/etc/polkit-1/rules.d/50-larm-runtime-control.rules"

systemctl_log="${test_root}/var/lib/larm/install-systemctl.log"
grep -F "enable llama-server.service llama-swap-worker.service qwen-asr.service voicevox-tts.service larm-daemon.service" \
  "${systemctl_log}" >/dev/null
grep -F "disable qwen-tts.service" "${systemctl_log}" >/dev/null
[[ -d "${test_root}/srv/ai/models/qwen-tts" ]]

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
