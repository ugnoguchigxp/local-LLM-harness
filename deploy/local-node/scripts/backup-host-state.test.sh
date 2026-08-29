#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tool="${repo_root}/deploy/local-node/scripts/backup-host-state.sh"
test_root="$(mktemp -d /tmp/larm-backup-test.XXXXXX)"
trap 'rm -rf -- "${test_root}"' EXIT
mkdir -p "${test_root}/etc/systemd/system" "${test_root}/srv/ai/apps"
printf '[Unit]\nDescription=old llama\n' >"${test_root}/etc/systemd/system/llama-server.service"
ln -s /srv/ai/apps/larm-releases/old "${test_root}/srv/ai/apps/larm-current"
label=20260829T010000Z-abcdef1
backup_root="${test_root}/backups"

run_tool() {
  LARM_BACKUP_TEST_MODE=1 LARM_BACKUP_TEST_ROOT="${test_root}" \
    LARM_BACKUP_ROOT="${backup_root}" LARM_BACKUP_LABEL="${label}" bash "${tool}" "$@"
}

plan="$(run_tool plan)"
jq -e '.allowed == true and .currentPointer.type == "symlink"
  and ([.units[] | select(.unit == "llama-server.service" and .type == "regular")] | length == 1)' \
  <<<"${plan}" >/dev/null
confirmation="$(jq -er .confirmation <<<"${plan}")"
LARM_BACKUP_TEST_MODE=1 LARM_BACKUP_TEST_ROOT="${test_root}" \
  LARM_BACKUP_ROOT="${backup_root}" LARM_BACKUP_LABEL="${label}" \
  LARM_BACKUP_CONFIRM="${confirmation}" bash "${tool}" apply >/dev/null
target="${backup_root}/${label}"
cmp "${test_root}/etc/systemd/system/llama-server.service" "${target}/units/llama-server.service"
[[ "$(stat -c '%a' "${target}/manifest.json")" == "600" ]]
[[ "$(<"${target}/larm-current.target")" == "/srv/ai/apps/larm-releases/old" ]]

changing_label=20260829T010001Z-abcdef1
changing_plan="$(LARM_BACKUP_TEST_MODE=1 LARM_BACKUP_TEST_ROOT="${test_root}" \
  LARM_BACKUP_ROOT="${backup_root}" LARM_BACKUP_LABEL="${changing_label}" bash "${tool}" plan)"
changing_confirmation="$(jq -er .confirmation <<<"${changing_plan}")"
if LARM_BACKUP_TEST_MODE=1 LARM_BACKUP_TEST_ROOT="${test_root}" \
  LARM_BACKUP_ROOT="${backup_root}" LARM_BACKUP_LABEL="${changing_label}" \
  LARM_BACKUP_TEST_MUTATE_AFTER_COPY_UNIT=llama-server.service \
  LARM_BACKUP_CONFIRM="${changing_confirmation}" bash "${tool}" apply >/dev/null 2>&1; then
  echo "host backup accepted state that changed during capture" >&2
  exit 1
fi
[[ ! -e "${backup_root}/${changing_label}" ]]
sed -i '$d' "${test_root}/etc/systemd/system/llama-server.service"

unsafe_label=20260829T010002Z-abcdef1
rm "${test_root}/etc/systemd/system/llama-server.service"
ln -s /tmp "${test_root}/etc/systemd/system/llama-server.service"
if LARM_BACKUP_TEST_MODE=1 LARM_BACKUP_TEST_ROOT="${test_root}" \
  LARM_BACKUP_ROOT="${backup_root}" LARM_BACKUP_LABEL="${unsafe_label}" \
  bash "${tool}" plan | jq -e '.allowed == true' >/dev/null; then
  echo "host backup accepted a symlinked unit" >&2
  exit 1
fi

echo "host backup tests passed"
