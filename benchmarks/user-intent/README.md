# Ruri user-intent training

This is an offline trainer and inference adapter. It does not change the running
speaking-attitude service, expose a new API, or activate a Warm intent Provider.
The encoder remains frozen and is the same pinned INT8 Ruri encoder used by
speaking-attitude. No data, embeddings, coefficients, or measurement files belong
in this source repository.

The supplied 2026-10-29 dataset defines five labels: `request`, `chat`, `followup`,
`noise`, and `incomplete`. These replace the earlier three-label proposal for this
training run. `toolchain` is metadata; this head does **not** predict a handler.
The README within the attachment describes its author's labeling decisions;
it is not authority to change host behavior or activate a service.

Inputs are only `previous_agent` and `text`. The context input includes the first
160 history tokens and is capped at 512 tokens by right truncation. A second
input embeds the latest text alone. The optional surface feature candidate adds
fixed signed 4,096-bucket character hashing for 1–4 character substrings, with
start/end markers and log-count L2 normalization. No evaluation vocabulary or
statistics are fitted. One ONNX session serves both embedding calls. The final
v3 head has 4,608 features and 92,180 bytes of FP32 coefficients.

The supplied `eval.jsonl` is preserved. Its 270 rows never fit weights,
regularization, or temperature. The 1,084 supplied training rows are grouped by
normalized targets and near-duplicate long targets, then split into 867 fit and
217 calibration rows. Three-fold group CV on the fit partition selects feature
mode and C; calibration fits only scalar temperature. Original conversation and
template IDs are absent, so this is not proof of conversation-independent
evaluation. Three near-duplicate groups cross the supplied train/eval boundary;
the report also measures the 267 eval rows outside those groups.

Three exploratory revisions were evaluated on the supplied eval partition.
After the first evaluation informed feature-design changes, the later evaluations
are development measurements, not a fresh blind test. A new test set is needed
before claiming generalization. Labels were supplied as model-labeled, with
55 ambiguous records in `review.jsonl`; no human review is asserted and their
labels were retained.

## Reproduce training

Use the existing pinned benchmark environment. Installed versions for this run:
NumPy 2.5.3, SciPy 1.18.1, scikit-learn 1.9.1, ONNX Runtime 1.30.0,
Tokenizers 0.23.2. The inference adapter uses only NumPy, Tokenizers and ORT.

Choose a new external output directory; existing runs are never overwritten.

```bash
PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 \
OPENBLAS_NUM_THREADS=4 NUMEXPR_NUM_THREADS=4 TOKENIZERS_PARALLELISM=false \
/srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/user-intent/train.py \
  --data /srv/ai/benchmarks/user-intent/received-2026-10-29/intent-dataset-2026-10-29 \
  --encoder-root /srv/ai/models/ruri-speaking-attitude-v1 \
  --encoder-manifest apps/ruri-system-one/assets.json \
  --select-features --surface-features \
  --output /srv/ai/benchmarks/user-intent/training/NEW-REVISION
```

`--select-features` compares context, current-text, and concatenated embeddings.
`--surface-features` also compares the character-hash candidate. Both selections
use fit-only CV, without calibration or eval labels. Without these flags the
trainer uses context-only embeddings. Dataset files, sources, splits, encoder,
coefficients, calibration and predictions are hash-bound in external manifests.

The trained candidate is saved in
`/srv/ai/models/ruri-user-intent-v1-20261029`, referencing the existing encoder
instead of duplicating its weights. It contains portable JSON coefficients,
calibration, manifests, report and a snapshot of the matching inference source.
The training directory also preserves original predictions and embeddings.

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=4 \
/srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/user-intent/verify.py \
  --model-root /srv/ai/models/ruri-user-intent-v1-20261029 \
  --encoder-root /srv/ai/models/ruri-speaking-attitude-v1 \
  --predictions /srv/ai/benchmarks/user-intent/training/2026-10-29-v3/eval-predictions.jsonl \
  --output /srv/ai/benchmarks/user-intent/verification/NEW-REVISION
```

Verification uses three fresh processes and the exact saved inference source.
It checks all 270 predictions and logits against saved training output, then
reports load time, inference time and process RSS/PSS. No Torch or scikit-learn
is imported during inference. Counts are not multiplied by timing repetitions.

## Tests

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=4 \
/srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  -m unittest discover -s benchmarks/user-intent -p 'test_*.py'
```

The nine tests cover supervision-field exclusion, history truncation, context
use, duplicate grouping, independent calibration groups, numerical stability,
request/noise error accounting, external output locations and deterministic
character features. End-to-end verification additionally checks the trained
artifacts against encoder hashes and fresh-process predictions.

## Result and activation boundary

The v3 candidate scored 188/270 (69.6%), Macro F1 0.669; real past utterances
scored 41/78 (52.6%), synthetic utterances 147/192 (76.6%). Request recall was
71/103 (68.9%); incomplete recall was 11/26 (42.3%). Training-fold selection
favored this candidate despite its lower real-data accuracy than context-only
v1. It is a provisional candidate, not evidence that the trained classifier can
reliably suppress noise or hold incomplete speech in production.

The full receipt and per-label results are in the Spec HTML document
`specs/ruri-user-intent-training-2026-10-29.html`. Integrating model selection,
sharing the running Encoder with attitude, adding a Profile Provider and Warm
readiness, and selecting fallback thresholds remain separate work.
