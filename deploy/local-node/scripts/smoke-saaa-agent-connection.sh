#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
base_url="${base_url%/}"
timeout_seconds="${LARM_SAAA_SMOKE_TIMEOUT_SECONDS:-600}"
agent_profile="${LARM_AGENT_PROFILE:-}"
expected_default_agent_profile="${LARM_EXPECTED_DEFAULT_AGENT_PROFILE:-coding-default}"
agent_capability="${LARM_AGENT_CAPABILITY:-llm.coding}"
agent_audience="${LARM_AGENT_AUDIENCE:-saaa-desktop}"
agent_client="${LARM_AGENT_CLIENT:-saaa-desktop}"
agent_runtime="${LARM_AGENT_RUNTIME:-qwen-general}"
wait_for_runtime_release="${LARM_AGENT_WAIT_FOR_RUNTIME_RELEASE:-0}"
ttl_seconds="${LARM_AGENT_TTL_SECONDS:-300}"
release_timeout_seconds="${LARM_SAAA_RELEASE_TIMEOUT_SECONDS:-120}"
require_release_identity="${LARM_SAAA_SMOKE_REQUIRE_RELEASE_IDENTITY:-1}"
connection_id=""
scratch_dir=""

[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ && "${timeout_seconds}" -le 3600 ]] || {
  echo "LARM_SAAA_SMOKE_TIMEOUT_SECONDS must be an integer from 1 through 3600" >&2
  exit 2
}
[[ "${ttl_seconds}" =~ ^[1-9][0-9]*$ && "${ttl_seconds}" -le 86400 ]] || {
  echo "LARM_AGENT_TTL_SECONDS must be an integer from 1 through 86400" >&2
  exit 2
}
[[ "${release_timeout_seconds}" =~ ^[1-9][0-9]*$ && "${release_timeout_seconds}" -le 600 ]] || {
  echo "LARM_SAAA_RELEASE_TIMEOUT_SECONDS must be an integer from 1 through 600" >&2
  exit 2
}
[[ "${require_release_identity}" == "0" || "${require_release_identity}" == "1" ]] || {
  echo "LARM_SAAA_SMOKE_REQUIRE_RELEASE_IDENTITY must be 0 or 1" >&2
  exit 2
}
[[ "${wait_for_runtime_release}" == "0" || "${wait_for_runtime_release}" == "1" ]] || {
  echo "LARM_AGENT_WAIT_FOR_RUNTIME_RELEASE must be 0 or 1" >&2
  exit 2
}
[[ "${expected_default_agent_profile}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
  echo "LARM_EXPECTED_DEFAULT_AGENT_PROFILE must be a valid Agent Profile identifier" >&2
  exit 2
}
if [[ -n "${agent_profile}" && ! "${agent_profile}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "LARM_AGENT_PROFILE must be a valid Agent Profile identifier" >&2
  exit 2
fi
if [[ "${wait_for_runtime_release}" == "1" && -z "${LARM_API_TOKEN:-}" ]]; then
  echo "LARM_API_TOKEN is required when LARM_AGENT_WAIT_FOR_RUNTIME_RELEASE=1" >&2
  exit 2
fi
if [[ "${agent_audience}" == "saaa-desktop" \
  && "${base_url}" =~ ^https?://(localhost|127\.[0-9.]+|\[::1\])(:[0-9]+)?$ ]]; then
  echo "LARM_BASE_URL must use the LAN hostname or current DHCP address for saaa-desktop" >&2
  exit 2
fi
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/larm-saaa-smoke.XXXXXX")"

curl_bearer() {
  local token="$1"
  shift
  curl --config <(printf 'header = "Authorization: Bearer %s"\n' "${token}") "$@"
}

curl_control() {
  if [[ -n "${LARM_API_TOKEN:-}" ]]; then
    curl_bearer "${LARM_API_TOKEN}" "$@"
  else
    curl "$@"
  fi
}

release_connection() {
  local status
  [[ -n "${connection_id}" ]] || return 0
  status="$(curl_control -sS --max-time 15 -o /dev/null -w '%{http_code}' \
    -X DELETE "${base_url}/v1/agent-connections/${connection_id}" || true)"
  if [[ "${status}" != "204" ]]; then
    echo "failed to release Agent Connection during cleanup: HTTP ${status:-unavailable}" >&2
    return 1
  fi
  connection_id=""
}

cleanup() {
  release_connection || true
  [[ -z "${scratch_dir}" ]] || rm -rf -- "${scratch_dir}"
}
trap cleanup EXIT

health="$(curl -fsS --max-time 10 "${base_url}/health")"
jq -e --arg requireReleaseIdentity "${require_release_identity}" \
  '.status == "ok"
  and ((.releaseCommit | test("^[a-f0-9]{40}$")) or ($requireReleaseIdentity == "0" and .releaseCommit == "development"))
  and (.configRevision | length > 0) and (.bootEpoch | length > 0)' <<<"${health}" >/dev/null

readiness="$(curl -fsS --max-time 10 "${base_url}/ready")"
jq -e '.status == "ready"' <<<"${readiness}" >/dev/null

curl_control -fsS --max-time 15 \
  -D "${scratch_dir}/profiles.headers" \
  -o "${scratch_dir}/profiles.json" \
  "${base_url}/v1/agent-profiles"
config_revision="$(awk '
  tolower($1) == "x-larm-config-revision:" { gsub(/\r/, "", $2); value = $2 }
  END { print value }
' "${scratch_dir}/profiles.headers")"
[[ "${config_revision}" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Agent Profile response has an invalid x-larm-config-revision" >&2
  exit 1
}
default_agent_profile="$(jq -er '.defaultAgentProfile' "${scratch_dir}/profiles.json")"
[[ "${default_agent_profile}" == "${expected_default_agent_profile}" ]] || {
  echo "Agent Profile API advertised unexpected default ${default_agent_profile}" >&2
  exit 1
}
explicit_agent_profile=false
if [[ -z "${agent_profile}" ]]; then
  agent_profile="${default_agent_profile}"
elif [[ "${agent_profile}" != "${default_agent_profile}" ]]; then
  explicit_agent_profile=true
fi
jq -e --arg agentProfile "${agent_profile}" --arg agentCapability "${agent_capability}" \
  --arg audience "${agent_audience}" \
  --arg configRevision "${config_revision}" \
  --arg defaultAgentProfile "${default_agent_profile}" \
  --argjson explicitAgentProfile "${explicit_agent_profile}" \
  '.contractVersion == "agent-connection.v1"
  and .catalogRevision == $configRevision
  and .defaultAgentProfile == $defaultAgentProfile
  and (.audiences | index($audience)) != null
  and any(.profiles[]; .id == $agentProfile
    and .selectionPolicy == (if $explicitAgentProfile then "explicit-only" else "default" end)
    and any(.providers[]; .name == "llm"
      and .capability == $agentCapability
      and (.supportedCapabilities | index("llm.general")) != null
      and (.supportedCapabilities | index("llm.reasoning")) != null
      and (.supportedCapabilities | index("llm.coding")) != null
      and .protocol == "openai.chat-completions.v1"
      and .model == $agentProfile
      and .streamingProtocol == "saaa.llm-stream.v1"))' \
  "${scratch_dir}/profiles.json" >/dev/null

connection_request="$(jq -cn \
  --arg agentProfile "${agent_profile}" \
  --arg audience "${agent_audience}" \
  --arg client "${agent_client}" \
  --argjson explicitAgentProfile "${explicit_agent_profile}" \
  --argjson ttlSeconds "${ttl_seconds}" \
  '{audience:$audience,client:$client,ttlSeconds:$ttlSeconds,
    allowFallback:false,deploymentPolicy:"existing-only"}
    + (if $explicitAgentProfile then
      {agentProfile:$agentProfile,explicitAgentProfile:true}
    else {} end)')"
create_status="$(curl_control -sS --max-time 30 \
  -X POST "${base_url}/v1/agent-connections" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: saaa-smoke-${BASHPID}-${RANDOM}" \
  -D "${scratch_dir}/connection.headers" \
  -o "${scratch_dir}/connection.json" \
  -w '%{http_code}' \
  -d "${connection_request}")"
connection="$(<"${scratch_dir}/connection.json")"
connection_id="$(jq -er '.id // empty' <<<"${connection}" 2>/dev/null || true)"
[[ "${create_status}" == "200" || "${create_status}" == "201" || "${create_status}" == "202" ]] || {
  echo "Agent Connection create returned HTTP ${create_status:-unavailable}" >&2
  exit 1
}
[[ -n "${connection_id}" ]] || {
  echo "Agent Connection create did not return an id" >&2
  exit 1
}
location="$(awk '
  tolower($1) == "location:" { gsub(/\r/, "", $2); value = $2 }
  END { print value }
' "${scratch_dir}/connection.headers")"
[[ "${location}" == "/v1/agent-connections/${connection_id}" ]] || {
  echo "Agent Connection create returned an invalid Location" >&2
  exit 1
}

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
      connection="$(curl_control -fsS --max-time 15 \
        "${base_url}/v1/agent-connections/${connection_id}")"
      ;;
    *)
      echo "Agent Connection entered terminal state: ${status}" >&2
      exit 1
      ;;
  esac
done

jq -e --arg agentProfile "${agent_profile}" --arg audience "${agent_audience}" \
  --arg requestBaseUrl "${base_url}/v1" \
  '.agentProfile == $agentProfile and .audience == $audience
  and .status == "ready" and (.providers | length == 1)
  and .providers[0].name == "llm" and .providers[0].publicModel == $agentProfile
  and .providers[0].claimable == true' <<<"${connection}" >/dev/null

claim="$(curl_control -fsS --max-time 30 \
  -X POST "${base_url}/v1/agent-connections/${connection_id}/claim" \
  -H 'Content-Type: application/json' \
  -d '{"format":"openai-provider-v1"}')"

jq -e --arg agentProfile "${agent_profile}" --arg audience "${agent_audience}" \
  --arg requestBaseUrl "${base_url}/v1" \
  '.status == "ready" and .audience == $audience and (.providers | length == 1)
  and .providers[0].name == "llm" and .providers[0].apiStyle == "openai"
  and .providers[0].model == $agentProfile
  and .providers[0].configuration.kind == "openai-provider-v1"
  and .providers[0].configuration.fields.model == $agentProfile
  and .providers[0].configuration.fields.baseURL == .providers[0].baseUrl
  and .providers[0].configuration.secretFields.apiKey == "credential.token"
  and .providers[0].credential.type == "bearer"
  and .providers[0].credential.expiresAt == .expiresAt
  and .providers[0].streaming.protocol == "saaa.llm-stream.v1"
  and .providers[0].streaming.encoding == "json-control+binary-delta-v1"
  and .providers[0].streaming.compression == "none"
  and .providers[0].streaming.upstreamTransport == "native"
  and .providers[0].streaming.maxConcurrentRuns >= 1
  and .providers[0].streaming.maxConnections == .providers[0].streaming.maxConcurrentRuns
  and .providers[0].streaming.resumeWindowMs >= 120000
  and ($audience != "saaa-desktop" or (
    .providers[0].port == 9810
    and .providers[0].baseUrl == $requestBaseUrl
    and (.providers[0].host | IN("127.0.0.1", "::1", "localhost") | not)
    and .providers[0].streaming.url == (
      $requestBaseUrl
      | sub("^http:"; "ws:")
      | sub("^https:"; "wss:")
      | . + "/llm/stream"
    )
  ))
  and (.providers[0].credential.token | length > 0)' <<<"${claim}" >/dev/null

provider_model="$(jq -er '.providers[0].model' <<<"${claim}")"
provider_health_url="$(jq -er '.providers[0].health.url' <<<"${claim}")"
provider_token="$(jq -er '.providers[0].credential.token' <<<"${claim}")"
provider_stream_url="$(jq -er '.providers[0].streaming.url' <<<"${claim}")"
provider_allocation_id="$(jq -er '.allocationId' <<<"${claim}")"

provider_health="$(curl_bearer "${provider_token}" -fsS --max-time 30 "${provider_health_url}")"
jq -e '.name == "llm" and .ready == true and .acceptingRequests == true
  and .probe.kind == "semantic-inference" and .probe.validated == true' \
  <<<"${provider_health}" >/dev/null

LARM_SAAA_STREAM_URL="${provider_stream_url}" \
LARM_SAAA_PROVIDER_TOKEN="${provider_token}" \
LARM_SAAA_ALLOCATION_ID="${provider_allocation_id}" \
LARM_SAAA_MODEL="${provider_model}" \
LARM_SAAA_SMOKE_TIMEOUT_MS="$((timeout_seconds > 300 ? 300000 : timeout_seconds * 1000))" \
  bun run "${repo_root}/deploy/local-node/scripts/smoke-saaa-websocket.ts"

release_status="$(curl_control -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  -X DELETE "${base_url}/v1/agent-connections/${connection_id}")"
[[ "${release_status}" == "204" ]] || {
  echo "Agent Connection release returned HTTP ${release_status}" >&2
  exit 1
}

released_connection="$(curl_control -fsS --max-time 15 \
  "${base_url}/v1/agent-connections/${connection_id}")"
jq -e --arg connectionId "${connection_id}" \
  '.id == $connectionId and .status == "released" and (.releasedAt | length > 0)' \
  <<<"${released_connection}" >/dev/null

revoked_status="$(curl_bearer "${provider_token}" -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  "${provider_health_url}" || true)"
[[ "${revoked_status}" == "401" ]] || {
  echo "released Provider token was not rejected: HTTP ${revoked_status:-unavailable}" >&2
  exit 1
}

if [[ "${wait_for_runtime_release}" == "1" ]]; then
  release_deadline=$((SECONDS + release_timeout_seconds))
  while true; do
    state="$(curl_bearer "${LARM_API_TOKEN}" -fsS --max-time 15 "${base_url}/state")"
    runtime_status="$(jq -er --arg runtime "${agent_runtime}" \
      '[.runtimes[] | select(.id == $runtime) | .status][0] // "missing"' <<<"${state}")"
    case "${runtime_status}" in
      HOT|BUSY|STARTING)
        if ((SECONDS >= release_deadline)); then
          echo "released Agent runtime remained ${runtime_status} after the cleanup deadline" >&2
          exit 1
        fi
        sleep 1
        ;;
      *)
        break
        ;;
    esac
  done
fi

connection_id=""

provider_token=""
claim=""
echo "SAAA Agent Connection REST smoke passed"
