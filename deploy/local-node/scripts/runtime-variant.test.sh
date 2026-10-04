#!/usr/bin/env bash
set -euo pipefail
test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT
export LARM_VARIANT_TEST_ROOT="${test_root}"
mkdir "${test_root}/bin"
cat >"${test_root}/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${LARM_VARIANT_TEST_ROOT}/calls"
case "$1" in
  is-active) [[ "${LARM_VARIANT_TEST_HEALTHY:-0}" == 1 ]] ;;
  stop) [[ "${LARM_VARIANT_TEST_STOP_FAIL:-0}" == 0 ]]; touch "${LARM_VARIANT_TEST_ROOT}/stopped" ;;
  start) [[ "${LARM_VARIANT_TEST_START_FAIL:-0}" == 0 ]]; touch "${LARM_VARIANT_TEST_ROOT}/started" ;;
  *) exit 2 ;;
esac
SH
cat >"${test_root}/bin/awk" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -e "${LARM_VARIANT_TEST_ROOT}/stopped" && "${LARM_VARIANT_TEST_LOW_MEMORY:-0}" == 0 ]]; then
  echo 67108864
else
  echo 1048576
fi
SH
cat >"${test_root}/bin/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "${test_root}/bin/"*
export PATH="${test_root}/bin:${PATH}"
script="$(dirname "${BASH_SOURCE[0]}")/runtime-variant.sh"

# The incoming worker fits after the idle peer's memory is released.
bash "${script}" start music
test -e "${test_root}/started"
grep -Fx 'stop larm-image-qwen21.service' "${test_root}/calls" >/dev/null

# Insufficient memory or a failed peer stop must prevent launch.
rm "${test_root}/started" "${test_root}/stopped"
if LARM_VARIANT_TEST_LOW_MEMORY=1 bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test ! -e "${test_root}/started"

# Failed launch and startup deadline both clean up the requested worker.
: >"${test_root}/calls"
if LARM_VARIANT_TEST_START_FAIL=1 bash "${script}" start music >/dev/null 2>&1; then exit 1; fi
test "$(tail -n 1 "${test_root}/calls")" = 'stop larm-music-ace-step.service'
curl() { SECONDS=$((SECONDS + 301)); return 1; }
export -f curl
: >"${test_root}/calls"
if bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test "$(tail -n 1 "${test_root}/calls")" = 'stop larm-image-qwen21.service'
unset -f curl
rm -f "${test_root}/started"
rm "${test_root}/stopped"
if LARM_VARIANT_TEST_STOP_FAIL=1 bash "${script}" start image >/dev/null 2>&1; then exit 1; fi
test ! -e "${test_root}/started"

# Rechecking a healthy warm worker must leave it and its peer untouched.
: >"${test_root}/calls"
LARM_VARIANT_TEST_HEALTHY=1 bash "${script}" start image
test "$(wc -l <"${test_root}/calls")" -eq 1
echo 'media variant switching tests passed'
