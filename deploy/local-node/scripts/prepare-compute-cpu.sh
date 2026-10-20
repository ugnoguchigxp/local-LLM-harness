#!/usr/bin/env bash
set -euo pipefail

# Prepares dependencies only. Does not start, stop, or restart any service.
compute_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
compute_runtime_root="${LARM_COMPUTE_RUNTIME_ROOT:-/srv/ai/runtimes/larm-compute-cpu}"
case "${compute_runtime_root}" in
  /*) ;;
  *) echo "LARM_COMPUTE_RUNTIME_ROOT must be absolute" >&2; exit 1 ;;
esac
compute_runtime_root="$(realpath -m -- "${compute_runtime_root}")"
case "${compute_runtime_root}" in
  /|"${compute_repo_root}"|"${compute_repo_root}"/*)
    echo "CPU Python needs a dedicated directory outside the source repository" >&2; exit 1 ;;
esac
for compute_dependency in uv bwrap python3; do
  command -v "${compute_dependency}" >/dev/null || { echo "missing dependency: ${compute_dependency}" >&2; exit 1; }
done
if [[ ! -x "${compute_runtime_root}/bin/python3" ]]; then
  uv venv --python /usr/bin/python3 "${compute_runtime_root}"
fi
test -f "${compute_runtime_root}/pyvenv.cfg" || { echo "CPU Python directory must be a virtual environment" >&2; exit 1; }
uv pip sync --python "${compute_runtime_root}/bin/python3" --require-hashes \
  "${compute_repo_root}/apps/compute-cpu/requirements.txt"
echo "CPU Python environment prepared. Configure LARM_COMPUTE_ENABLED, LARM_COMPUTE_PUBLIC_ORIGIN, and LARM_COMPUTE_ROOT before deployment."
