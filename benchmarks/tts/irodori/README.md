# Irodori-TTS benchmark

This benchmark compares the existing VOICEVOX provider with Irodori-TTS Anime,
Irodori MeanFlow, and audio.cpp without adding inference runtimes or model weights
to LARM. Profiles pin the upstream source and model revisions used for the study.

## Safety and data placement

- Keep checkouts under `/srv/ai/apps`, weights under `/srv/ai/models`, caches under
  `/srv/ai/cache`, and results under `/srv/ai/results` (or equivalent external paths).
- Never put reference audio, generated audio, model weights, or speaker inversion
  artifacts in this repository.
- A reference voice is opt-in through `BENCH_TTS_REFERENCE_WAV`. Without a
  consented local file, run no-reference/caption-only tests and mark fixed-speaker
  validation incomplete.
- Start and stop only the process IDs created for the benchmark. Do not stop the
  resident LLM, ASR, or TTS services for co-resident measurements.

## Corpus

`ja-quality.jsonl` contains 31 utterances. `ja-latency.jsonl` is the fixed set of
four short, four medium, and four long utterances. `ja-dictionary.jsonl` provides
identical display text and dictionary-expanded spoken text for A/B runs.

The runner sends `spoken_text` by default. Use `--text raw` for dictionary A and
`--text spoken` for dictionary B. Dictionary replacement itself is deliberately
limited to the benchmark helper: NFKC is applied first, then longest match,
priority, and declaration order.

## Run

The provider must already be listening at the URL in its profile. Override a URL
with `--url`; use `--mode larm` when that URL is the LARM public speech route.

```bash
bun run bench:tts:irodori --profile voicevox-cpu --dry-run
bun run bench:tts:irodori \
  --profile irodori-anime-audiocpp-cpu-q8 \
  --output /srv/ai/results/larm/tts/anime-q8-c1 \
  --warmups 2 --iterations 5 --concurrency 1 --seed 42 --save-audio
bun run bench:tts:report --input /srv/ai/results/larm/tts/anime-q8-c1
```

Useful options are `--corpus`, `--url`, `--mode direct|larm`,
`--text raw|spoken`, `--warmups`, `--iterations`, `--concurrency`, `--seed`,
`--timeout-ms`, `--save-audio`, and `--dry-run`. Each completed request is
appended immediately to `runs.jsonl`. SIGINT stops scheduling new batches and
preserves completed requests.

## Output

Each external run directory contains `environment.json`, `runs.jsonl`, and,
after report generation, `summary.json`, `summary.csv`, and `summary.md`.
`audio/` is created only with `--save-audio`. HTTP TTFB and first playable audio
are recorded separately, although non-streaming providers commonly deliver both
at the same time.

Run the local unit suite with:

```bash
bun test benchmarks/tts/irodori/tests
```

Network/model integration remains opt-in and is not part of the normal unit test
suite.
