#!/usr/bin/env bash
set -euo pipefail
trial_root=/srv/ai/apps/larm-granite-trial
dropin=/etc/systemd/system/larm-daemon.service.d/90-granite-asr-trial.conf
action="${1:-}"
[[ ${EUID} -eq 0 ]] || { echo 'Service registration requires administrator authentication.' >&2; exit 1; }
[[ ${action} == apply || ${action} == restore ]] || { echo 'usage: activate.sh apply|restore' >&2; exit 2; }
expected_dropin=$'[Service]\nEnvironment=LARM_CONFIG_DIR=/srv/ai/apps/larm-granite-trial/config'
if [[ ${action} == restore ]]; then
  [[ -f ${dropin} && ! -L ${dropin} && $(cat "${dropin}") == "${expected_dropin}" ]] \
    || { echo 'Expected Granite trial override is absent or has changed.' >&2; exit 1; }
  rm -- "${dropin}"
  systemctl daemon-reload
  systemctl restart larm-daemon.service
  systemctl stop granite-asr-trial.service
  echo 'Original release configuration restored; Granite trial stopped.'
  exit 0
fi
[[ ! -e ${dropin} && ! -L ${dropin} ]] || { echo 'An override already exists; refusing to overwrite it.' >&2; exit 1; }
test -x "${trial_root}/.venv/bin/uvicorn"
test -f "${trial_root}/api-evidence.json"
jq -e '.ok == true' "${trial_root}/api-evidence.json" >/dev/null
test -f "${trial_root}/memory-evidence.json"
jq -e '.peakCombinedGiB < 3.5 and ([.results[].status] == [200,200,413])' "${trial_root}/memory-evidence.json" >/dev/null
expected_release="$(jq -er .activeRelease "${trial_root}/prepared.json")"
[[ $(readlink -f /srv/ai/apps/larm-current) == "${expected_release}" ]] \
  || { echo 'Active release changed since preparation; prepare against the new baseline.' >&2; exit 1; }
while IFS=$'\t' read -r name digest; do
  [[ $(sha256sum "${expected_release}/config/local-node/${name}" | cut -d ' ' -f1) == "${digest}" ]] \
    || { echo 'Baseline configuration changed; refusing activation.' >&2; exit 1; }
done < <(jq -r '.baselineFiles | to_entries[] | [.key,.value] | @tsv' "${trial_root}/prepared.json")
for target in /etc/systemd/system/granite-asr-trial.service /etc/polkit-1/rules.d/53-larm-granite-runtime-control.rules; do
  [[ ! -L ${target} ]] || { echo "Refusing symlink target: ${target}" >&2; exit 1; }
  if [[ -e ${target} ]]; then
    cmp -s "${trial_root}/$(basename "${target}")" "${target}" \
      || { echo "Target belongs to a different installation: ${target}" >&2; exit 1; }
  fi
done
install -o root -g root -m 0644 "${trial_root}/granite-asr-trial.service" /etc/systemd/system/granite-asr-trial.service
install -o root -g root -m 0644 "${trial_root}/53-larm-granite-runtime-control.rules" /etc/polkit-1/rules.d/53-larm-granite-runtime-control.rules
install -d -o root -g root -m 0755 /etc/systemd/system/larm-daemon.service.d
systemctl daemon-reload
systemctl start granite-asr-trial.service
healthy=0
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS --max-time 2 http://127.0.0.1:8089/health | jq -e '.status == "ok" and .model == "granite-speech-4.1-2b"' >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
[[ ${healthy} -eq 1 ]] || { systemctl stop granite-asr-trial.service; echo 'Granite did not become healthy.' >&2; exit 1; }
printf '%s\n' "${expected_dropin}" >"${dropin}"
if ! systemctl daemon-reload || ! systemctl restart larm-daemon.service \
  || ! runuser -u ugnoguchi -- /home/ugnoguchi/.bun/bin/bun run /srv/ai/apps/local-LLM-harness/deploy/local-node/scripts/smoke-granite-asr-profile.ts; then
  rm -- "${dropin}"
  systemctl daemon-reload
  systemctl restart larm-daemon.service
  systemctl stop granite-asr-trial.service
  echo 'Activation failed; original configuration restored.' >&2
  exit 1
fi
echo 'Granite ASR trial applied to SAAA-gemma4-26b. Existing clients reconnect after the daemon restart.'
