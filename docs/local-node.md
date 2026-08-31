# local-node: AI MAX+ 395 Linux provider

`local-node` is the first Linux deployment of LARM. It keeps the interactive voice path hot
while providing one resident Qwen3.8 27B LLM, a general 256K worker pool, and bounded 64K
Agent workers that fit beside the resident model.

## Desired runtime map

This table describes the repository-managed desired state. Check the live host with
`systemctl is-active`, `systemctl is-enabled`, and `ss -ltnp`; do not infer current service
state from this document alone.

| Port | Runtime | Policy | Purpose |
| ---: | --- | --- | --- |
| 8080 | Qwen3.8-27B ROCmFP4 FAST + MTP | resident | primary reasoning/coding |
| 8081 | Qwen3-ASR 1.7B FP16 | resident backup | explicit `stt-qwen` / default fallback |
| 8082 | Qwen3-TTS 0.6B optimized | preferred | expressive speech |
| 8083 | llama-swap | resident executor | on-demand 256K general and 64K Agent workers |
| 8084 | VOICEVOX CORE 0.17.0 | resident | low-latency speech |
| 8085 | Whisper large-v3-turbo Q5 HIP | trial resident | primary Japanese transcription |
| 8090 | native LLM stream Provider | external resident companion | `larm.native-llm-stream.v1`, loopback only |
| 9810 | LARM daemon | control plane | authenticated LAN Gateway |

The repository-managed Runtime units bind ports 8080–8085 to loopback. `prepare-host.sh` installs
host prerequisites but does not change or enable UFW. The focused SAAA REST access tool manages
only the reviewed source-host rule for the authenticated LARM Gateway and never changes SSH rules.
Runtime control and health use loopback endpoints from
[`../config/local-node/runtimes.yaml`](../config/local-node/runtimes.yaml).
The production LARM unit listens on all host interfaces at port 9810, requires both API and
management credentials, and derives the SAAA claim URL from the authenticated Connection request
origin. It does not store or advertise a fixed LAN address. Restrict port 9810 to the reviewed SAAA
source host; use TLS termination before extending this boundary beyond that network.
The live host observed on 2026-08-29 still used wildcard Provider listeners. The
[`Production Completion plan`](../specs/production-completion-plan.html) applies the loopback
units one Provider at a time and removes only rules named by a reviewed convergence digest after
the Ambient canary succeeds.

### SAAA desktop direct connection

SAAA discovers a DHCP-aware hostname such as `gnosis.local` (or receives the current host URL from
operator configuration), calls that control URL, and requests audience `saaa-desktop`. The claim
uses the request's scheme, hostname or current address, and port with the canonical `/v1` path.
SAAA passes that `baseUrl`, `model`, and short-lived `credential.token` to its OpenAI-compatible
client without rewriting them. The long-lived `LARM_API_TOKEN` remains in the macOS secret store,
not in routing configuration. LARM ignores `X-Forwarded-*`; a future reverse-proxy deployment needs
a separately reviewed trusted-proxy contract.

Provider ports 8080–8084 remain loopback-only. Only the authenticated Gateway at 9810 is exposed
to the reviewed SAAA source host. An unauthenticated control request must return 401, while `/health` and
`/ready` remain credential-free operational probes and do not disclose Provider endpoints.

LLM realtime output uses `saaa.llm-stream.v1` at the claim-provided
`/v1/llm/stream` WSS URL. Port 8090 is the external runtime's native event endpoint; it is never
exposed to SAAA and must not implement or proxy SSE. LARM probes its exact
`larm.native-llm-stream.v1` subprotocol and requires a strict semantic readiness declaration for
SAD1 encoding, pause/resume, cancel, tool continuation, usage, and advertised capacity before
advertising `streaming`. The currently installed
`llama-server` exposes only HTTP/SSE streaming, so it cannot satisfy that prerequisite by itself;
until a native companion is commissioned, claims deliberately omit the streaming descriptor.
After the native companion and production certificate are commissioned, run
`bun run smoke:saaa-websocket` and then `bun run soak:saaa-websocket`. The soak gate holds the test
for at least 30 minutes, completes at least 1,000 turns, deliberately disconnects after the first
delta of every turn, validates exact replay through `run.resume`, reports p50/p95/p99 turn and first
delta latency, and rejects excess peak or settled RSS growth.
Set `LARM_BASE_URL`, `LARM_API_TOKEN`, and `LARM_SAAA_CONNECTION_ID` for the soak runner. During
every planned disconnect it renews and reclaims that same Agent Connection, requires a newly
rotated Provider credential, verifies the claim invariants, and resumes with the new credential.

## Why this split

- The ROCmFP4 build is the primary because the goal is Qwen3.8-27B quality with maximum
  interactive decode speed on gfx1151.
- `UD-Q4_K_XL` is the quality-oriented 256K worker and `Q4_0` is its faster fallback.
  Both are loaded through llama-swap only when needed.
- Ornith-1.5-35B-A3B uses the official Q5_K_M artifact for the quality route and the
  gfx1151-specific ROCmFP4 STRIX_LEAN artifact for the explicit speed route. Both disable
  MTP and ngram; Ornith KV cache uses q8_0 for both K and V after local perplexity validation.
  `ngram-mod` stays disabled, and q38rocm prompt/idle-slot caching is disabled after a repeat-request
  sequence assertion reproduced on local-node. Qwen3.6-35B remains an explicit comparison and fallback
  Runtime in the same swap group.
- `coding-worker` and `deep-reasoning-35b` use separate 64K launch contracts. Their admission
  reservations are 28 GB and 30 GB respectively; the latter includes the q8_0 Value cache selected
  after perplexity validation.
- Qwen3-ASR 1.7B stays resident: the measured error reduction was worth roughly 3 GB over
  the 0.6B fallback for voice-chat input.
- VOICEVOX is the normal response voice because it remains real-time while the LLM is busy.
  Qwen3-TTS is an opt-in expressive voice because it competes with the LLM for the same GPU.

## Measurements on local-node

These are local acceptance measurements, not upstream performance claims.

| Path | Result |
| --- | --- |
| Qwen3-ASR 1.7B, 17 Japanese clips | CER 3.50%, aggregate RTF 0.154 |
| Qwen3-ASR 0.6B, same clips | CER 8.93%, aggregate RTF 0.078 |
| VOICEVOX, idle | RTF 0.055 |
| VOICEVOX while primary LLM runs | RTF 0.070; 9.74 s audio in 0.683 s |
| Qwen3-TTS 0.6B optimized, idle | non-stream RTF 0.505-0.520; stream TTFB 0.342 s |
| Qwen3-TTS while primary LLM runs | TTFB 1.319 s; RTF 2.448 |

The repository does not contain the raw clips, command transcript, or machine-readable result
set for these historical measurements. Treat them as baseline context, not a reproducible release
gate. Record each future acceptance run in a Spec HTML summary with the exact procedure,
configuration revision, aggregate results, and location of repository-external raw data.

## Operations

Run this sequence only from the reviewed clean commit that completes the repository part of
Production Completion Milestone 22 and has a verified rollback target.
Before running the installer, preserve any existing unit and release pointer in the
operator-owned backup location described in
[`../deploy/local-node/README.md`](../deploy/local-node/README.md).

```bash
cd /srv/ai/apps/local-LLM-harness
deploy/local-node/scripts/preflight-larm.sh
# Create the reviewed, digest-bound host backup documented in deploy/local-node/README.md.
sudo deploy/local-node/scripts/install-services.sh
deploy/local-node/scripts/release-larm.sh plan
sudo deploy/local-node/scripts/release-larm.sh apply
deploy/local-node/scripts/verify.sh
deploy/local-node/scripts/smoke-larm.sh
deploy/local-node/scripts/shadow-larm.sh
# Attended voice validation only:
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/local-node/scripts/smoke-voice.sh
# After calibrating deploy/local-node/slo.yaml from the same production identity:
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# LARM_CANARY_ITERATIONS=3 deploy/local-node/scripts/canary-gate.sh
# Attended fault inventory; mutations require LARM_FAULT_CONFIRM=local-node-attended:
deploy/local-node/scripts/fault-larm.sh plan
systemctl is-active llama-server.service llama-swap-worker.service \
  qwen-asr.service whisper-asr.service voicevox-tts.service larm-daemon.service
systemctl is-enabled llama-server.service llama-swap-worker.service \
  qwen-asr.service whisper-asr.service voicevox-tts.service larm-daemon.service qwen-tts.service
journalctl -u llama-server.service -f
journalctl -u qwen-asr.service -f
journalctl -u whisper-asr.service -f
journalctl -u voicevox-tts.service -f
journalctl -u larm-daemon.service -f
```

If `release-larm.sh plan` returns cleanup candidates, review them and pass its
`cleanupConfirm` value through `LARM_RELEASE_CLEANUP_CONFIRM` to the matching `apply`.
An unreviewed or changed candidate set is rejected before deletion or activation.

After the repository installer is applied, the expected enablement is Resident/control units
enabled and `qwen-tts.service` disabled. A Preferred service may still be active temporarily
while an explicit Allocation uses it; enabled and active are separate states.
The latest retained host observation is recorded in
[`commissioning-evidence.html`](../specs/commissioning-evidence.html); rerun preflight rather than
assuming that observation is still current.

LARM自身は`/srv/ai/apps/larm-releases/<commit-prefix>`へ世代固定し、
`/srv/ai/apps/larm-current`のatomic symlinkをdaemon unitが参照します。rollbackは
`sudo deploy/local-node/scripts/release-larm.sh rollback`でLARM daemonだけを前世代へ戻します。

The host uses a 100 GB TTM/GTT setting. Check it with `amd-ttm` after an attended boot.
Do not automate `reboot`: the machine is dual boot and may start Windows.

The desired state leaves `qwen-tts.service` installed but disabled at boot because it is
Preferred. LARM starts and stops only that service through the narrow rule in
[`../deploy/local-node/polkit/50-larm-runtime-control.rules`](../deploy/local-node/polkit/50-larm-runtime-control.rules).
Resident provider units remain outside unattended lifecycle authorization.

VOICEVOX output must be credited as `VOICEVOX:春日部つむぎ` with the current default
speaker. If the speaker changes, update the displayed credit accordingly.
