# Ruri sentence language classifier

Train a **whole-sentence Japanese/English binary classifier** using exactly
200 Japanese and 200 English authored sentences. This is separate from the
token-level segmentation pilot and the existing six-class attitude model.

`examples.jsonl` is the reviewable source dataset: 400 training examples,
40 calibration examples (20 per language) and 200 evaluation examples
(100 per language). `corpus.py` contains their authored bilingual pairs and
fixed split assignments. Paired translations stay together, and conversation
and topic/template groups do not cross partitions. Text is synthetic, not
collected or human-reviewed production conversation data.

The requested training-only file is `training400.jsonl`: all 200 Japanese and
200 English sentences were fitted, with no validation split taken out of these
400. The user subsequently requested 50 additional judgement examples;
`evaluation50.jsonl` holds **25 new Japanese and 25 new English** sentences,
authored after the model was frozen. They are separate from all earlier data.
Romanized Japanese is excluded from the current scope at the user's request.

The label describes the whole sentence's language. Japanese sentences can
contain CPU, GitHub or an English quotation; English sentences can quote a
Japanese button name. Neither word-specific dictionaries nor script-detection
rules determine the model's answer. Boundary, pause and TTS routing are outside
this experiment.

Run the pinned existing external training environment:

```sh
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4 \
  /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/sentence-language/run.py --precision int8 \
  --output /srv/ai/benchmarks/sentence-language/new-int8-run
```

Use `--precision fp32` and a new result directory for the FP32 comparison.
The runner checks the existing sentence ONNX graph/tokenizer hashes and refuses
source-tree output, existing output directories, changed source data, cross-split
conversation/template groups and near-duplicate text (similarity >= 0.9).
It uses the existing pooled 256-dimensional Ruri encoder without changing its
weights. Only a new two-class linear head is trained. Regularization and
temperature use calibration labels only; evaluation labels never fit the model.

Evaluate the frozen model on the requested 50 new sentences without training:

```sh
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 \
  /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/sentence-language/evaluate50.py \
  --model-dir /srv/ai/benchmarks/sentence-language/new-int8-run \
  --output /srv/ai/benchmarks/sentence-language/new-evaluation50-run
```

The evaluator checks that the saved head used all 400 original training IDs.
It reports current-scope probe scores separately, preserving the earlier probe
run including romanized Japanese. It cannot adjust the head or calibration.

Each result directory contains the trained `head.json`, hash `manifest.json`,
source/data snapshots, held-out predictions/errors, fixed supplemental probes,
`report.json` and 200 local inference timing trials per language. Existing Ruri
and LARM services are not changed. These timings include fresh tokenization,
ONNX inference and the head, but not HTTP, admission queues or playback.

Return only a label using the saved head:

```sh
PYTHONDONTWRITEBYTECODE=1 /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/sentence-language/predict.py \
  --model-dir /srv/ai/benchmarks/sentence-language/new-int8-run \
  --text 'これは日本語の文章です。'
```

The output is `ja` or `en`. Omit `--text` to read stdin; use `--json` only when
scores and metadata are needed. Empty input and >512 tokens fail explicitly;
there is no silent truncation or default Japanese fallback. Numerical strings,
bare URLs and balanced mixed paragraphs have no binary sentence-language gold;
their forced predictions are recorded separately from accuracy on sentences.

Corpus checks, without model dependencies:

```sh
bun run test:sentence-language
```

The Spec HTML at `specs/ruri-sentence-language-classification-2026-10-12.html`
records the measured result, scope and reproducibility information.
