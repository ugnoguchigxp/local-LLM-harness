# gnosis: AI MAX+ 395 Linux provider

`gnosis` is the first Linux deployment of LARM. It keeps the interactive voice path hot
while providing one resident Qwen3.8 27B LLM, a general 256K worker pool, and bounded 64K
Agent workers that fit beside the resident model.

## Desired runtime map

This table describes the repository-managed desired state. Check the live host with
`systemctl is-active`, `systemctl is-enabled`, and `ss -ltnp`; do not infer current service
state from this document alone.

| Port | Runtime | Policy | Purpose |
| ---: | --- | --- | --- |
| 8080 | Qwen3.8-27B ROCmFP4 FAST + MTP | resident | primary reasoning/coding |
| 8081 | Qwen3-ASR 1.7B FP16 | resident | accurate Japanese transcription |
| 8082 | Qwen3-TTS 0.6B optimized | preferred | expressive speech |
| 8083 | llama-swap | resident executor | on-demand 256K general and 64K Agent workers |
| 8084 | VOICEVOX CORE 0.17.0 | resident | low-latency speech |
| 9810 | LARM daemon | control plane | authenticated LAN Gateway |

The repository-managed Runtime units bind ports 8080–8084 to loopback. `prepare-host.sh` adds
reviewed LAN rules for SSH administration and the authenticated LARM Gateway, and deliberately
neither enables UFW nor removes legacy rules.
Runtime control and health use loopback endpoints from
[`../config/gnosis/runtimes.yaml`](../config/gnosis/runtimes.yaml).
The production LARM unit listens on all host interfaces at port 9810, requires both API and
management credentials, and advertises the gnosis LAN identity `192.168.0.65` to SAAA. Restrict
port 9810 to the reviewed trusted LAN CIDR; use TLS termination before extending this boundary
beyond that network.
The live host observed on 2026-08-29 still used wildcard Provider listeners. The
[`Production Completion plan`](../specs/production-completion-plan.html) applies the loopback
units one Provider at a time and removes only rules named by a reviewed convergence digest after
the Ambient canary succeeds.

### SAAA desktop direct connection

SAAA stores the gnosis host address `192.168.0.65`, calls the control API at
`http://192.168.0.65:9810`, and requests audience `saaa-desktop`. The claim advertises
`http://192.168.0.65:9810/v1`; SAAA passes that `baseUrl`, `model`, and short-lived
`credential.token` to its OpenAI-compatible client without rewriting them. The long-lived
`LARM_API_TOKEN` remains in the macOS secret store, not in routing configuration.

Provider ports 8080–8084 remain loopback-only. Only the authenticated Gateway at 9810 is exposed
to the reviewed LAN CIDR. An unauthenticated control request must return 401, while `/health` and
`/ready` remain credential-free operational probes and do not disclose Provider endpoints.

## Why this split

- The ROCmFP4 build is the primary because the goal is Qwen3.8-27B quality with maximum
  interactive decode speed on gfx1151.
- `UD-Q4_K_XL` is the quality-oriented 256K worker and `Q4_0` is its faster fallback.
  Both are loaded through llama-swap only when needed.
- Ornith-1.5-35B-A3B uses the official Q5_K_M artifact for the quality route and the
  gfx1151-specific ROCmFP4 STRIX_LEAN artifact for the explicit speed route. Both disable
  MTP and ngram; Ornith KV cache uses q8_0 for both K and V after local perplexity validation.
  `ngram-mod` stays disabled, and q38rocm prompt/idle-slot caching is disabled after a repeat-request
  sequence assertion reproduced on gnosis. Qwen3.6-35B remains an explicit comparison and fallback
  Runtime in the same swap group.
- `coding-worker` and `deep-reasoning-35b` use separate 64K launch contracts. Their admission
  reservations are 28 GB and 30 GB respectively; the latter includes the q8_0 Value cache selected
  after perplexity validation.
- Qwen3-ASR 1.7B stays resident: the measured error reduction was worth roughly 3 GB over
  the 0.6B fallback for voice-chat input.
- VOICEVOX is the normal response voice because it remains real-time while the LLM is busy.
  Qwen3-TTS is an opt-in expressive voice because it competes with the LLM for the same GPU.

## Measurements on gnosis

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
[`../deploy/gnosis/README.md`](../deploy/gnosis/README.md).

```bash
cd /srv/ai/apps/local-LLM-harness
deploy/gnosis/scripts/preflight-larm.sh
# Create the reviewed, digest-bound host backup documented in deploy/gnosis/README.md.
sudo deploy/gnosis/scripts/install-services.sh
deploy/gnosis/scripts/release-larm.sh plan
sudo deploy/gnosis/scripts/release-larm.sh apply
deploy/gnosis/scripts/verify.sh
deploy/gnosis/scripts/smoke-larm.sh
deploy/gnosis/scripts/shadow-larm.sh
# Attended voice validation only:
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/gnosis/scripts/smoke-voice.sh
# After calibrating deploy/gnosis/slo.yaml from the same production identity:
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# LARM_CANARY_ITERATIONS=3 deploy/gnosis/scripts/canary-gate.sh
# Attended fault inventory; mutations require LARM_FAULT_CONFIRM=gnosis-attended:
deploy/gnosis/scripts/fault-larm.sh plan
systemctl is-active llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service
systemctl is-enabled llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service qwen-tts.service
journalctl -u llama-server.service -f
journalctl -u qwen-asr.service -f
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
`sudo deploy/gnosis/scripts/release-larm.sh rollback`でLARM daemonだけを前世代へ戻します。

The host uses a 100 GB TTM/GTT setting. Check it with `amd-ttm` after an attended boot.
Do not automate `reboot`: the machine is dual boot and may start Windows.

The desired state leaves `qwen-tts.service` installed but disabled at boot because it is
Preferred. LARM starts and stops only that service through the narrow rule in
[`../deploy/gnosis/polkit/50-larm-runtime-control.rules`](../deploy/gnosis/polkit/50-larm-runtime-control.rules).
Resident provider units remain outside unattended lifecycle authorization.

VOICEVOX output must be credited as `VOICEVOX:春日部つむぎ` with the current default
speaker. If the speaker changes, update the displayed credit accordingly.
