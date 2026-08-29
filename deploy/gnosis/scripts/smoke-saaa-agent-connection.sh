#!/usr/bin/env bash
set -euo pipefail

base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
timeout_seconds="${LARM_SAAA_SMOKE_TIMEOUT_SECONDS:-600}"
agent_profile="${LARM_AGENT_PROFILE:-deep-reasoning-35b}"
agent_audience="${LARM_AGENT_AUDIENCE:-saaa-desktop}"
agent_client="${LARM_AGENT_CLIENT:-saaa-desktop}"
require_release_identity="${LARM_SAAA_SMOKE_REQUIRE_RELEASE_IDENTITY:-1}"
connection_id=""

[[ -n "${LARM_API_TOKEN:-}" ]] || {
  echo "LARM_API_TOKEN is required" >&2
  exit 2
}
[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ && "${timeout_seconds}" -le 3600 ]] || {
  echo "LARM_SAAA_SMOKE_TIMEOUT_SECONDS must be an integer from 1 through 3600" >&2
  exit 2
}
[[ "${require_release_identity}" == "0" || "${require_release_identity}" == "1" ]] || {
  echo "LARM_SAAA_SMOKE_REQUIRE_RELEASE_IDENTITY must be 0 or 1" >&2
  exit 2
}

curl_bearer() {
  local token="$1"
  shift
  curl --config <(printf 'header = "Authorization: Bearer %s"\n' "${token}") "$@"
}

release_connection() {
  local status
  [[ -n "${connection_id}" ]] || return 0
  status="$(curl_bearer "${LARM_API_TOKEN}" -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    -X DELETE "${base_url}/v1/agent-connections/${connection_id}" || true)"
  if [[ "${status}" != "204" ]]; then
    echo "failed to release Agent Connection during cleanup: HTTP ${status:-unavailable}" >&2
    return 1
  fi
  connection_id=""
}

cleanup() {
  release_connection || true
}
trap cleanup EXIT

health="$(curl -fsS --max-time 10 "${base_url}/health")"
jq -e --arg requireReleaseIdentity "${require_release_identity}" \
  '.status == "ok"
  and ((.releaseCommit | test("^[a-f0-9]{40}$")) or ($requireReleaseIdentity == "0" and .releaseCommit == "development"))
  and (.configRevision | length > 0) and (.bootEpoch | length > 0)' <<<"${health}" >/dev/null

connection_request="$(jq -cn \
  --arg agentProfile "${agent_profile}" \
  --arg audience "${agent_audience}" \
  --arg client "${agent_client}" \
  '{agentProfile:$agentProfile,audience:$audience,client:$client,ttlSeconds:900,
    allowFallback:false,deploymentPolicy:"existing-only"}')"
connection="$(curl_bearer "${LARM_API_TOKEN}" -fsS --max-time 30 \
  -X POST "${base_url}/v1/agent-connections" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: saaa-smoke-${BASHPID}-${RANDOM}" \
  -d "${connection_request}")"
connection_id="$(jq -er '.id' <<<"${connection}")"

deadline=$((SECONDS + timeout_seconds))
while true; do
  status="$(jq -er '.status' <<<"${connection}")"
  case "${status}" in
    ready)
      break
      ;;
    pending|probing)
      if ((SECONDS >= deadline)); then
        echo "Agent Connection did not become ready before the deadline" >&2
        exit 1
      fi
      sleep 1
      connection="$(curl_bearer "${LARM_API_TOKEN}" -fsS --max-time 15 \
        "${base_url}/v1/agent-connections/${connection_id}")"
      ;;
    *)
      echo "Agent Connection entered terminal state: ${status}" >&2
      exit 1
      ;;
  esac
done

jq -e --arg agentProfile "${agent_profile}" --arg audience "${agent_audience}" \
  '.agentProfile == $agentProfile and .audience == $audience
  and .status == "ready" and (.providers | length == 1)
  and .providers[0].name == "llm" and .providers[0].publicModel == $agentProfile
  and .providers[0].claimable == true' <<<"${connection}" >/dev/null

claim="$(curl_bearer "${LARM_API_TOKEN}" -fsS --max-time 30 \
  -X POST "${base_url}/v1/agent-connections/${connection_id}/claim" \
  -H 'Content-Type: application/json' \
  -d '{"format":"openai-provider-v1"}')"

jq -e --arg agentProfile "${agent_profile}" --arg audience "${agent_audience}" \
  '.status == "ready" and .audience == $audience and (.providers | length == 1)
  and .providers[0].name == "llm" and .providers[0].apiStyle == "openai"
  and .providers[0].model == $agentProfile
  and .providers[0].configuration.kind == "openai-provider-v1"
  and .providers[0].configuration.fields.model == $agentProfile
  and .providers[0].configuration.fields.baseURL == .providers[0].baseUrl
  and .providers[0].configuration.secretFields.apiKey == "credential.token"
  and .providers[0].credential.type == "bearer"
  and (.providers[0].credential.token | length > 0)' <<<"${claim}" >/dev/null

provider_base_url="$(jq -er '.providers[0].baseUrl' <<<"${claim}")"
provider_model="$(jq -er '.providers[0].model' <<<"${claim}")"
provider_health_url="$(jq -er '.providers[0].health.url' <<<"${claim}")"
provider_token="$(jq -er '.providers[0].credential.token' <<<"${claim}")"

provider_health="$(curl_bearer "${provider_token}" -fsS --max-time 30 "${provider_health_url}")"
jq -e '.name == "llm" and .ready == true and .acceptingRequests == true
  and .probe.kind == "semantic-inference" and .probe.validated == true' \
  <<<"${provider_health}" >/dev/null

curl_bearer "${provider_token}" -fsS -N --max-time 300 \
  -X POST "${provider_base_url}/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg model "${provider_model}" \
    '{model:$model,stream:true,max_tokens:8,messages:[{role:"user",content:"Reply with OK."}]}')" \
  | awk '
      { sub(/\r$/, "") }
      /^data: / && $0 != "data: [DONE]" { seen_data = 1 }
      /^data: \[DONE\]$/ { seen_done = 1 }
      END { if (!seen_data || !seen_done) exit 1 }
    '

release_status="$(curl_bearer "${LARM_API_TOKEN}" -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  -X DELETE "${base_url}/v1/agent-connections/${connection_id}")"
[[ "${release_status}" == "204" ]] || {
  echo "Agent Connection release returned HTTP ${release_status}" >&2
  exit 1
}
connection_id=""

revoked_status="$(curl_bearer "${provider_token}" -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  "${provider_health_url}" || true)"
[[ "${revoked_status}" == "401" ]] || {
  echo "released Provider token was not rejected: HTTP ${revoked_status:-unavailable}" >&2
  exit 1
}

provider_token=""
claim=""
echo "SAAA Agent Connection REST smoke passed"
