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

curl -fsS -N --max-time 300 "${headers[@]}" \
  -X POST "${base_url}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -d '{"model":"ignored-by-larm","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"Reply with OK."}]}' \
  | awk '
      { sub(/\r$/, "") }
      /^data: / && $0 != "data: [DONE]" { seen_data = 1 }
      /^data: \[DONE\]$/ { seen_done = 1 }
      END { if (!seen_data || !seen_done) exit 1 }
    '

curl -fsS --max-time 10 "${headers[@]}" -X DELETE \
  "${base_url}/v1/allocations/${allocation_id}" >/dev/null
allocation_id=""
echo "LARM resident Qwen 3.8 27B smoke passed"
