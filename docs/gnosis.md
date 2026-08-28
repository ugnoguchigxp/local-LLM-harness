# gnosis: AI MAX+ 395 Linux provider

`gnosis` is the first Linux deployment of LARM. It keeps the interactive voice path hot
while providing one resident Qwen3.8 27B LLM and two on-demand 256K worker variants.

## Runtime map

| Port | Runtime | Policy | Purpose |
| ---: | --- | --- | --- |
| 8080 | Qwen3.8-27B ROCmFP4 FAST + MTP | resident | primary reasoning/coding |
| 8081 | Qwen3-ASR 1.7B FP16 | resident | accurate Japanese transcription |
| 8082 | Qwen3-TTS 0.6B optimized | preferred | expressive speech |
| 8083 | llama-swap | resident executor | on-demand 256K Q4 workers |
| 8084 | VOICEVOX CORE 0.17.0 | resident | low-latency speech |
| 9810 | LARM daemon | control plane | allocation and local Gateway |

The Runtime ports bind to all interfaces, but UFW permits TCP 22 and 8080-8084 only from
`192.168.0.0/24`. Runtime control and health use loopback endpoints from
[`../config/gnosis/runtimes.yaml`](../config/gnosis/runtimes.yaml).
LARM remains loopback-only on port 9810; expose it through an authenticated local
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

## Operations

```bash
cd /srv/ai/apps/local-LLM-harness
deploy/gnosis/scripts/verify.sh
journalctl -u llama-server.service -f
journalctl -u qwen-asr.service -f
journalctl -u voicevox-tts.service -f
journalctl -u larm-daemon.service -f
```

The host uses a 100 GB TTM/GTT setting. Check it with `amd-ttm` after an attended boot.
Do not automate `reboot`: the machine is dual boot and may start Windows.

`qwen-tts.service` is installed but disabled at boot because it is Preferred. LARM starts
and stops only that service through the narrow rule in
[`../deploy/gnosis/polkit/50-larm-runtime-control.rules`](../deploy/gnosis/polkit/50-larm-runtime-control.rules).
Resident provider units remain outside unattended lifecycle authorization.

VOICEVOX output must be credited as `VOICEVOX:春日部つむぎ` with the current default
speaker. If the speaker changes, update the displayed credit accordingly.
