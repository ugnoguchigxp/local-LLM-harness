#!/usr/bin/env bash
set -euo pipefail

base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
headers=(-H 'Content-Type: application/json')
if [[ -n "${LARM_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")
fi

lease_id=""
allocation_id=""
cleanup() {
  if [[ -n "${allocation_id}" ]]; then
    curl -fsS --max-time 10 -X DELETE "${headers[@]}" \
      "${base_url}/v1/allocations/${allocation_id}" >/dev/null || true
  fi
  if [[ -n "${lease_id}" ]]; then
    curl -fsS --max-time 10 -X POST "${headers[@]}" \
      -d "$(jq -n --arg leaseId "${lease_id}" '{leaseId:$leaseId}')" \
      "${base_url}/release" >/dev/null || true
  fi
}
trap cleanup EXIT

legacy="$(curl -fsS --max-time 30 -X POST "${headers[@]}" \
  -d '{"capabilities":["llm.general"],"client":"larm-shadow"}' "${base_url}/prepare")"
lease_id="$(jq -er .leaseId <<<"${legacy}")"
[[ "$(jq -er .ready <<<"${legacy}")" == "true" ]] \
  || { echo "legacy shadow binding is not immediately ready" >&2; exit 1; }
legacy_resolve="$(curl -fsS --max-time 10 -X POST "${headers[@]}" \
  -d '{"capability":"llm.general"}' "${base_url}/resolve")"

allocation="$(curl -fsS --max-time 30 -X POST "${headers[@]}" \
  -H "Idempotency-Key: shadow-$(date +%s%N)" \
  -d '{"requirements":[{"capability":"llm.general","route":"llm-default"}],"allowFallback":false,"deploymentPolicy":"existing-only","ttlSeconds":60,"client":"larm-shadow"}' \
  "${base_url}/v1/allocations")"
allocation_id="$(jq -er .id <<<"${allocation}")"
[[ "$(jq -er .status <<<"${allocation}")" == "ready" ]] \
  || { echo "v1 shadow allocation is not immediately ready" >&2; exit 1; }
v1_resolve="$(curl -fsS --max-time 10 -X POST "${headers[@]}" \
  -d '{"capability":"llm.general"}' "${base_url}/v1/allocations/${allocation_id}/resolve")"

jq -e -n --argjson legacy "${legacy_resolve}" --argjson v1 "${v1_resolve}" \
  '$legacy.runtime == $v1.runtime and $legacy.node == $v1.node and $legacy.endpoint == $v1.endpoint' \
  >/dev/null || { echo "legacy and v1 shadow resolution differ" >&2; exit 1; }
jq -n --arg runtime "$(jq -er .runtime <<<"${v1_resolve}")" \
  --arg route "$(jq -er '.bindings[0].route' <<<"${allocation}")" \
  --arg release "$(jq -r '.bindings[0].release // "unmanaged"' <<<"${allocation}")" \
  '{shadow:"matched",runtime:$runtime,route:$route,release:$release}'
