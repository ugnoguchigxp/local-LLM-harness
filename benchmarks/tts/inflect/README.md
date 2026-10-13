# Inflect Nano v2 trial

Compare the official English frontend with unsupported Japanese text, romaji,
Open JTalk IPA approximations, and manually authored IPA. No fine-tuning or
checkpoint changes. The manual IPA examples are per-sentence experiments, not
a general Japanese frontend.

Use an external checkout of `owensong/Inflect-Nano-v2` at revision
`71d70b00c8d9f9c3ca145e024b3351d327d98c51` for inference code and weights.
Install its requirements plus `pyopenjtalk` in an external Python environment.
Keep the source, weights, dependencies and generated WAV files outside this repo.

```sh
python benchmarks/tts/inflect/run.py \
  --runtime /srv/ai/apps/inflect-v2-trial \
  --model /srv/ai/models/Inflect-Nano-v2 \
  --output /srv/ai/benchmarks/inflect-nano-trial \
  --threads 4 --repeats 3
```

`--cases` selects comma-separated corpus IDs. Results include the exact input,
phonemes, seeds, synthesis time, duration, waveform statistics and WAV SHA-256.
Model load and warmup are separate from request timing. Standard requests include
the official frontend and output processing; automatic Japanese IPA requests
include Open JTalk preprocessing; manual IPA requests start at tokenization.
File writing is excluded from timing. All outputs use CPU, 24 kHz mono PCM16.

The 2026-10-12 trial used PyTorch 2.11.0+rocm7.13.0 on CPU with four threads,
three repetitions, seeds 42/43/44, variation 0.667, speed 1.0 except manual IPA
at 0.85. Existing services continued running. This is a small functional trial,
not a general quality or speed benchmark. ASR checks are supporting evidence;
listen to the WAV files to evaluate voice quality.
