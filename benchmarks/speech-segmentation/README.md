# Speech segmentation feasibility prototype

This is an **offline experiment**, not an activated Provider or an Eumenes
integration. The existing attitude model, deployment and System One API are
unchanged. The experimental model ID is
`ruri-v3-30m-speech-segmentation-prototype`. The proposed public extension uses
`POST /v1/systemone` with a new `segments` question/answer; today's gateway
deliberately does not accept it.

The Japanese Spec HTML in `specs/ruri-streaming-speech-segmentation-prototype-2026-10-12.html`
records the contract, pilot results, limitations and integration gates.

## Fixed contract and stream tests

```sh
bun test packages/core/src/speech-segmentation.test.ts benchmarks/speech-segmentation/stream-harness.test.ts
```

The stream harness simulates consumer-owned publication, coalescing, bounded
buffers, concurrent synthesis and source-ordered playback. Its decisions and
audio completions are fixed test fixtures. An `ended` callback, rather than an
estimated duration, starts the next utterance. Language changes do not insert
sentence pauses. Cancellation invalidates late decisions, audio and ended
callbacks. This proves simulator behavior, not behavior of real TTS or speakers.

The pure validator in `packages/core` uses Unicode code points and verifies
original slices, contiguous spans, monotonic commitment, explicit reading
instructions, input snapshots, deadlines and generation. Old input versions
are rejected unless the consumer opts into the documented full append-only
proof. It cannot determine whether a predicted boundary is linguistically safe.

## Real encoder, synthetic training and loopback HTTP timings

Use the pinned external avatar-attitude training environment documented in
`benchmarks/avatar-attitude/requirements.txt`, with the pinned ruri30 manifest
and snapshot. No downloads or live service changes are required on this host.

```sh
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4 \
  /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/speech-segmentation/prototype.py \
  --precision int8 --repeats 200 \
  --output /srv/ai/benchmarks/speech-segmentation/new-int8-run
```

Repeat with `--precision fp32` and a **new** external output directory to
separate quantization effects from head/data limitations. The runner refuses
an existing directory or any directory inside the source repository. It
exports a token-state ONNX graph, checks FP32 equivalence, trains language and
boundary/pause heads on the training partition, fits temperature and chooses
the boundary threshold on calibration only, and reports evaluation errors.
No labels, punctuation dictionaries or regular expressions determine spoken
language. Explicit user language overrides are applied as instructions.

Compute exact spoken-language interval precision/recall/F1 separately from
synthesis boundaries, using the saved evaluation predictions:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/speech-segmentation/analyze_intervals.py \
  --result-dir /srv/ai/benchmarks/speech-segmentation/new-int8-run
```

This writes `language-intervals.json` outside the repository and checks that
the corpus hash matches the recorded run before reconstructing gold intervals.

The hand-authored corpus contains 24 training, 8 calibration and 18 evaluation
scenarios, split by conversation/template group. Prefix observations stay in
their parent scenario's partition. Gold readings, pauses and safe positions
are predetermined. These 50 synthetic scenarios are **not human-reviewed real
conversations** and are not sufficient to certify Ruri for this task.
Whitespace belongs to exactly one span. Empty/ambiguous failures are covered
by fixed contract tests; the learned pilot does not certify abstention on
out-of-distribution text. The graph rejects >512 tokens without truncation.

Each of Japanese, English, mixed, incomplete and long inputs gets 200 fresh
loopback HTTP requests in isolation and another 200 with a separately loaded
unchanged attitude engine competing for CPU. The training environment needs
the existing external attitude Provider environment for that competitor.
Failure/timeout durations remain in percentiles; counts are separately
reported. The HTTP server is an ephemeral loopback-only experiment and uses a
small experimental body, not the proposed public envelope or LARM auth.

Output files include `report.json`, `pilot-evaluation.json`,
`evaluation-errors.json`, `http-trials.jsonl`, source snapshots, two heads, and
FP32/INT8 token graphs. They remain outside the repository. The report records
hashes, encoder revision, package versions, load/first inference measurements,
partition sizes and runtime conditions. Fresh session loading occurs after
export with warm filesystem caches; it is **not** cold process startup.

Not measured here: LARM admission queues, network/auth latency, linguistic
hold time, VOICEVOX/KittenTTS synthesis, decode, real playback, throughput,
cooperative backend cancellation, microphone or speaker behavior. A successful
HTTP response can still be `waiting` or `unresolved` and is not evidence of
speech readiness. The poor pilot quality blocks production integration.
