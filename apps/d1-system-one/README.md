# d1-2B game decision Provider

`d1-2b-game` serves typed `choice`, `noul` and `score` decisions through
`larm.system-one.v1`. Select `ornith1.5Strix-game` and request the
`game-decision` provider. The ordinary `ornith1.5Strix` voice profile and
ContextStill keep their existing providers. Ruri still handles speaking attitude.

The pinned LiquidAI/d1-2B snapshot and its upstream Python implementation live
outside this repository at `/srv/ai/models/d1-2b`. Startup verifies every file
against `assets.json`, loads once on Radeon 8060S via ROCm BF16, then warms the
model. CPU mode is an explicit operator setting; unavailable GPU execution fails
startup. Compilation is disabled. ROCm inference uses the upstream explicit FP32
attention path, with gfx1151 AOTriton enabled. Weights and upstream files remain byte-identical. Text and a 384px image are
warmed before startup completes. There is no token generation or hidden LLM fallback.

Requests have `model`, `state`, `questions`, and optional `images`. `state` is
text, a JSON object/array, or null with an image. Each image must be an inline
PNG/JPEG/WebP base64 data URL; network URLs are rejected. One image is accepted,
up to 2 MB decoded and 1,048,576 source pixels; it is resized proportionally to
fit 384 by 384 pixels before inference. Ordinary text-only consumers need no
request changes. Existing providers can reject images they do not support.

At most 16 questions are accepted. Choice candidates are named descriptions or
a list of unique descriptions. Score criteria have 2–10 ordered levels. A noul
answer retains its native yes probability and adds the LARM-required confidence
as `max(p_yes, 1-p_yes)`. Scores are model outputs, not measured game win rates.
The actual packed prompt, including all questions and image tokens, must fit
4,096 tokens. Oversized input is rejected with 422 instead of truncated.

LARM admits one inference at a time, queues at most four requests for up to
100 ms, and starts the service on demand. Direct concurrent backend calls return
429. The warm floor is zero, with 120 seconds of idle retention. Realtime games
must carry their own observation revision/deadline and discard stale decisions;
this Provider returns recommendations and never sends keyboard/controller input.

Prepare with `prepare-d1-runtime.sh`, then use
`provision-decision-artifacts.py` to download the pinned d1-2B snapshot or
`--verify-only` to check them. H2O-Lightning-4B is staged for later evaluation;
it has no runtime or public provider. All dependencies, weights and logs remain
outside this source-only repository. Register the new unit and narrow lifecycle
permission using `install-d1-service.sh`, then use the existing signed release
workflow. The installer does not enable or start the Provider.

The previous d1-3B release was validated on 2026-10-16. Its timing figures do
not describe d1-2B. Reacquire the connection after deployment to obtain the new
model name; assess real game quality and shared-load latency separately.
