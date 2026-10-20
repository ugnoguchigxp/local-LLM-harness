#!/usr/bin/env bash
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT
export LARM_VARIANT_TEST_ROOT="${test_root}"
export LARM_MEDIA_LOCK_PATH="${test_root}/variant.lock"
mkdir "${test_root}/bin"
cat >"${test_root}/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${LARM_VARIANT_TEST_ROOT}/calls"
case "$1" in
  show) printf "ActiveState=inactive\nMainPID=%s\n" "${LARM_VARIANT_TEST_REMAINING_PID:-0}" ;;
  is-active) [[ "${LARM_VARIANT_TEST_HEALTHY:-0}" == 1 || "$*" == *"${LARM_VARIANT_TEST_ACTIVE_PEER:-never}"* ]] ;;
  stop) [[ "${LARM_VARIANT_TEST_STOP_FAIL:-0}" == 0 ]]; touch "${LARM_VARIANT_TEST_ROOT}/stopped" ;;
  start) [[ "${LARM_VARIANT_TEST_START_FAIL:-0}" == 0 ]]; touch "${LARM_VARIANT_TEST_ROOT}/started" ;;
  *) exit 2 ;;
esac
SH
cat >"${test_root}/bin/awk" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${LARM_VARIANT_TEST_LOW_MEMORY:-0}" == 0 ]]; then
  echo 67108864
else
  echo 1048576
fi
SH
cat >"${test_root}/bin/curl" <<'SH'
#!/usr/bin/env bash
echo '{"status":"ok","loaded":true,"data":{"loaded":true,"models_initialized":true}}'
SH
chmod +x "${test_root}/bin/"*
export PATH="${test_root}/bin:${PATH}"
script="$(dirname "${BASH_SOURCE[0]}")/runtime-variant.sh"

# The incoming worker starts only when its peers are inactive.
bash "${script}" start music
test -e "${test_root}/started"
! grep -q '^stop larm-image' "${test_root}/calls"

# Insufficient memory or a failed peer stop must prevent launch.
rm -f "${test_root}/started" "${test_root}/stopped"
if LARM_VARIANT_TEST_LOW_MEMORY=1 bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test ! -e "${test_root}/started"

# Failed launch and startup deadline both clean up the requested worker.
: >"${test_root}/calls"
if LARM_VARIANT_TEST_START_FAIL=1 bash "${script}" start music >/dev/null 2>&1; then exit 1; fi
test "$(tail -n 2 "${test_root}/calls" | head -n 1)" = 'stop larm-music-ace-step.service'
curl() { SECONDS=$((SECONDS + 301)); return 1; }
export -f curl
: >"${test_root}/calls"
if LARM_MEDIA_START_TIMEOUT_SECONDS=0 bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test "$(tail -n 2 "${test_root}/calls" | head -n 1)" = 'stop larm-image-qwen21.service'
unset -f curl
rm -f "${test_root}/started"
rm -f "${test_root}/stopped"
if LARM_VARIANT_TEST_ACTIVE_PEER=larm-mesh-trellis2.service bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test ! -e "${test_root}/started"

# Rechecking a healthy warm worker must leave it and its peer untouched.
: >"${test_root}/calls"
LARM_VARIANT_TEST_HEALTHY=1 bash "${script}" start image
test "$(wc -l <"${test_root}/calls")" -eq 1
echo 'media variant switching tests passed'

# Inactive alone is insufficient when the worker PID remains alive.
if LARM_VARIANT_TEST_REMAINING_PID=123 bash "${script}" stop music >/dev/null 2>&1; then exit 1; fi
bash "${script}" stop music

bash "${script}" start mesh
bash "${script}" stop mesh

: >"${test_root}/calls"
bash "${script}" start stable-audio
grep -Fx 'start larm-audio-stable.service' "${test_root}/calls" >/dev/null
if grep -Fx 'start larm-music-ace-step.service' "${test_root}/calls"; then exit 1; fi
bash "${script}" stop stable-audio
