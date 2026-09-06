#!/usr/bin/env bash
set -euo pipefail

base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
allocation_id=""
headers=()
if [[ -n "${LARM_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")
fi

cleanup() {
  if [[ -n "${allocation_id}" ]]; then
    curl -fsS --max-time 10 "${headers[@]}" -X DELETE \
      "${base_url}/v1/allocations/${allocation_id}" >/dev/null || true
  fi
}
trap cleanup EXIT

health="$(curl -fsS --max-time 10 "${base_url}/health")"
jq -e '.status == "ok" and (.version | length > 0)
  and (.releaseCommit | test("^[a-f0-9]{40}$"))
  and (.configRevision | length > 0) and (.bootEpoch | length > 0)' \
  <<<"${health}" >/dev/null

service_base_url="${base_url%/}/v1"
services="$(curl -fsS --max-time 10 "${base_url%/}/v1/services")"
jq -e --arg base_url "${service_base_url}" '
  .contractVersion == "saaa-service-harness.v2"
  and (.revision | length > 0)
  and any(.services[]?;
    .capability == "asr"
    and .protocol == "openai.audio-transcriptions.v1"
    and .baseUrl == $base_url
    and .model == "qwen3-asr-1.7b"
    and .language == "auto"
    and (.streaming | not)
    and (.healthUrl | startswith($base_url)))' <<<"${services}" >/dev/null
asr_health_url="$(jq -er '.services[] | select(.capability == "asr") | .healthUrl' <<<"${services}")"
curl -fsS --max-time 10 "${asr_health_url}" \
  | jq -e '.status == "ok" and .model == "qwen3-asr-1.7b"' >/dev/null

if [[ -n "${LARM_CANARY_AUDIO_FILE:-}" ]]; then
  [[ -f "${LARM_CANARY_AUDIO_FILE}" ]] || {
    echo "LARM_CANARY_AUDIO_FILE is not a regular file" >&2
    exit 1
  }
  curl -fsS --max-time 300 -X POST "${service_base_url}/audio/transcriptions" \
    -F "file=@${LARM_CANARY_AUDIO_FILE}" \
    -F 'model=qwen3-asr-1.7b' \
    -F 'language=auto' \
    | jq -e '(.text | type == "string") and (.text | length > 0)' >/dev/null
fi

allocation="$(curl -fsS --max-time 15 "${headers[@]}" \
  -X POST "${base_url}/v1/allocations" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: smoke-${BASHPID}-${RANDOM}" \
  -d '{"requirements":[{"capability":"llm.general","route":"llm-default"}],"ttlSeconds":120}')"
allocation_id="$(jq -er '.id' <<<"${allocation}")"

deadline=$((SECONDS + 60))
while true; do
  case "$(jq -r '.status' <<<"${allocation}")" in
    ready)
      break
      ;;
    pending)
      if ((SECONDS >= deadline)); then
        echo "allocation did not become active" >&2
        exit 1
      fi
      sleep 1
      allocation="$(curl -fsS --max-time 10 "${headers[@]}" \
        "${base_url}/v1/allocations/${allocation_id}")"
      ;;
    *)
      echo "allocation entered a terminal failure state: ${allocation}" >&2
      exit 1
      ;;
  esac
done

jq -e '.bindings[] | select(.capability == "llm.general") | .runtime == "qwen-general"' \
  <<<"${allocation}" >/dev/null

completion="$(curl -fsS --max-time 300 "${headers[@]}" \
  -X POST "${base_url}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -d '{"model":"ignored-by-larm","stream":false,"max_tokens":8,"messages":[{"role":"user","content":"Reply with OK."}]}' )"
jq -e 'any(.choices[]?; ((.message.content // "") | length) > 0)' <<<"${completion}" >/dev/null

streaming_completion="$(curl -fsS -N --max-time 300 "${headers[@]}" \
  -X POST "${base_url}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -d '{"model":"ignored-by-larm","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"Reply with OK."}]}' )"
grep -Fqx 'data: [DONE]' <<<"${streaming_completion}"
sed -n 's/^data: \({.*}\)$/\1/p' <<<"${streaming_completion}" \
  | jq -s -e 'length > 0 and all(.[]; type == "object")' >/dev/null

curl -fsS --max-time 10 "${headers[@]}" -X DELETE \
  "${base_url}/v1/allocations/${allocation_id}" >/dev/null
allocation_id=""
echo "LARM resident Qwen 3.8 27B JSON/SSE and SAAA Service Harness smoke passed"
