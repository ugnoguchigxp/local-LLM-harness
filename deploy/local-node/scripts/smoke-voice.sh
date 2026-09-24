#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ -z "${LARM_CANARY_AUDIO_FILE:-}" || "${LARM_CANARY_AUDIO_FILE}" != /* \
  || ! -f "${LARM_CANARY_AUDIO_FILE}" || -L "${LARM_CANARY_AUDIO_FILE}" ]]; then
  echo "Set LARM_CANARY_AUDIO_FILE to an absolute, regular, non-sensitive audio sample" >&2
  exit 2
fi

base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
allocation_id=""
headers=()
if [[ -n "${LARM_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")
fi
temporary="$(mktemp -d /tmp/larm-voice-smoke.XXXXXX)"
response_headers="${temporary}/headers"
response_audio="${temporary}/audio"

cleanup() {
  rm -rf -- "${temporary}"
  if [[ -n "${allocation_id}" ]]; then
    curl -fsS --max-time 10 "${headers[@]}" -X DELETE \
      "${base_url}/v1/allocations/${allocation_id}" >/dev/null || true
  fi
}
trap cleanup EXIT

allocation="$(curl -fsS --max-time 15 "${headers[@]}" \
  -X POST "${base_url}/v1/allocations" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: voice-smoke-${BASHPID}-${RANDOM}" \
  -d '{"requirements":[{"capability":"llm.general","route":"llm-default"},{"capability":"speech.stt","route":"stt-default"},{"capability":"speech.tts","route":"tts-default"}],"ttlSeconds":180}')"
allocation_id="$(jq -er '.id' <<<"${allocation}")"

deadline=$((SECONDS + 60))
while true; do
  case "$(jq -r '.status' <<<"${allocation}")" in
    ready)
      break
      ;;
    pending)
      if ((SECONDS >= deadline)); then
        echo "voice allocation did not become active" >&2
        exit 1
      fi
      sleep 1
      allocation="$(curl -fsS --max-time 10 "${headers[@]}" \
        "${base_url}/v1/allocations/${allocation_id}")"
      ;;
    *)
      echo "voice allocation entered a terminal failure state: ${allocation}" >&2
      exit 1
      ;;
  esac
done

jq -e '
  ([.bindings[] | select(.capability == "llm.general" and .runtime == "ornith-general")] | length) == 1
  and ([.bindings[] | select(.capability == "speech.stt" and .runtime == "whisper-asr")] | length) == 1
  and ([.bindings[] | select(.capability == "speech.tts" and .runtime == "voicevox-tts")] | length) == 1
' <<<"${allocation}" >/dev/null

curl -fsS --max-time 300 "${headers[@]}" \
  -X POST "${base_url}/v1/audio/transcriptions" \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -F "file=@${LARM_CANARY_AUDIO_FILE}" \
  | jq -e 'type == "object" and (.text | type == "string" and length > 0)' >/dev/null

curl -fsS --max-time 300 "${headers[@]}" \
  -X POST "${base_url}/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -D "${response_headers}" \
  -o "${response_audio}" \
  -d "$(jq -cn --arg input "${LARM_CANARY_TTS_TEXT:-疎通確認です。}" '{model:"voicevox-core",input:$input,voice:"Kasukabe_Tsumugi",response_format:"wav"}')"

grep -Eiq '^content-type: audio/' "${response_headers}"
grep -Eiq '^x-voicevox-credit:' "${response_headers}"
[[ -s "${response_audio}" ]]

curl -fsS --max-time 10 "${headers[@]}" -X DELETE \
  "${base_url}/v1/allocations/${allocation_id}" >/dev/null
allocation_id=""
echo "LARM voice profile smoke passed"
