# gnosis: AI MAX+ 395 Linux provider

`gnosis` is the first Linux deployment of LARM. It keeps the interactive voice path hot
while providing one resident Qwen3.8 27B LLM and two on-demand 256K worker variants.

## Desired runtime map

This table describes the repository-managed desired state. Check the live host with
`systemctl is-active`, `systemctl is-enabled`, and `ss -ltnp`; do not infer current service
state from this document alone.

| Port | Runtime | Policy | Purpose |
| ---: | --- | --- | --- |
| 8080 | Qwen3.8-27B ROCmFP4 FAST + MTP | resident | primary reasoning/coding |
| 8081 | Qwen3-ASR 1.7B FP16 | resident | accurate Japanese transcription |
| 8082 | Qwen3-TTS 0.6B optimized | preferred | expressive speech |
| 8083 | llama-swap | resident executor | on-demand 256K Q4 workers |
| 8084 | VOICEVOX CORE 0.17.0 | resident | low-latency speech |
| 9810 | LARM daemon | control plane | allocation and local Gateway |

The Runtime ports are configured to bind to all interfaces. `prepare-host.sh` adds UFW rules
for TCP 22 and 8080-8084 from `192.168.0.0/24` by default, but deliberately does not enable
UFW. Those rules are not enforced until an operator reviews `ufw status` and explicitly
enables UFW. Runtime control and health use loopback endpoints from
[`../config/gnosis/runtimes.yaml`](../config/gnosis/runtimes.yaml).
LARM is configured as loopback-only on port 9810; expose it through an authenticated local
adapter or deliberately reviewed reverse proxy rather than opening the port directly.

## Why this split

- The ROCmFP4 build is the primary because the goal is Qwen3.8-27B quality with maximum
  interactive decode speed on gfx1151.
- `UD-Q4_K_XL` is the quality-oriented 256K worker and `Q4_0` is its faster fallback.
  Both are loaded through llama-swap only when needed.
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

```bash
cd /srv/ai/apps/local-LLM-harness
deploy/gnosis/scripts/preflight-larm.sh
deploy/gnosis/scripts/release-larm.sh plan
sudo deploy/gnosis/scripts/release-larm.sh apply
deploy/gnosis/scripts/verify.sh
deploy/gnosis/scripts/smoke-larm.sh
deploy/gnosis/scripts/shadow-larm.sh
# Attended voice validation only:
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/gnosis/scripts/smoke-voice.sh
LARM_CANARY_ITERATIONS=3 deploy/gnosis/scripts/canary-gate.sh
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
