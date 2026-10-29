# Ruri shared speaking-attitude and user-intent Provider

`model` selects `em` (speaking attitude) or `in` (user intent) on
`POST /v1/systemone`. Existing long names remain accepted aliases and responses
echo the requested model. Both heads are verified,
loaded and warmed at startup and share exactly one CPU ONNX session and request
lock. Intent uses two sequential Encoder calls plus fixed character features;
it does not reload or replace the attitude head. Existing attitude inputs and
outputs retain their contract.

The intent head is loaded from `RURI_INTENT_MODEL_ROOT` (default
`/srv/ai/models/ruri-user-intent-v1-20261029`) against the pinned
`assets-intent.json`. `RURI_INTENT_ASSET_MANIFEST` can select another explicitly
verified manifest. Intent requires the same encoder revision, graph and
tokenizer hashes as the attitude model; startup fails on mismatch.

For LARM access, create/claim profile `ruri-user-intent`, Provider `system-one`.
Its descriptor supplies the model, endpoint and scoped credential. The existing
attitude credential cannot authorize the other model. Profile requests resolve
through `system-one-ruri` to the same Warm runtime; existing conversation
profiles keep their original Provider sets.

```json
{
  "model": "in",
  "state": {"previous_agent": null, "text": "明日の天気を調べてください"},
  "questions": {"intent": {
    "type": "choice",
    "instructions": "最新のユーザー発言の意図を分類してください",
    "criteria": {
      "request": "依頼", "chat": "会話", "followup": "作業への返答",
      "noise": "雑音", "incomplete": "発話途中"
    }
  }}
}
```

Read `answers.intent.choice` and all five `probabilities`. All five labels are
required; instruction/criteria descriptions cannot redefine the trained task.
State is either the latest text string or an object containing `text` and
optional `previous_agent` (null or a nonempty string). Other state fields are
rejected, keeping assistant text and user intent separate. Text fields are
limited to 50,000 characters. Invalid/unknown models return 422 at the backend;
a mismatched scoped credential returns 400 at the Gateway.

Intent returns summed token usage across both Encoder calls, history truncation
separately from input truncation, per-head revisions and provisional calibration
status. It returns a classifier label, never an execution instruction. Evaluation
accuracy is 69.6%, real-utterance accuracy 52.6%; its five-way output is suitable
for the requested trial, not a verified basis for automatically discarding speech.

Run artifact integration tests with
`RURI_ARTIFACT_TESTS=1 PYTHONDONTWRITEBYTECODE=1 /srv/ai/apps/ruri-system-one/.venv/bin/python -m unittest discover -s apps/ruri-system-one -p 'test_*.py'`.
They compare all 270 saved eval logits through the API and interleave both tasks
under concurrent callers while verifying one shared session.

The sentence-language Provider was retired on 2026-10-16. Japanese/English
selection belongs in the consumer, using regular expressions. The runtime does
not load a language head.

The deployed six-label model and its pinned `assets.json` remain the default.
A separate 15-label model was trained on the reviewed synthetic v2 dataset on
2026-10-24 (900 train, 300 calibration, 300 evaluation). Its public name is
`ruri-v3-30m-speaking-attitude-v2`, with the frozen contract in
`contracts/expanded-v2.json` and artifact hashes in `assets-expanded-v2.json`.
The user accepted sad empathetic speech within `sadness` for this version;
`warmth` and `empathy` are absent as separate labels. The earlier
`expanded-v2-candidate.json` remains a draft/fixture contract.
Versioned contracts require `none` first, unique labels and descriptions,
input A, and a distinct public model name.

The model is saved at `/srv/ai/models/ruri-speaking-attitude-expanded-v2-20261024`
but is **not activated**. Synthetic evaluation accuracy is 224/300 (74.7%),
Macro F1 0.744. A separate regression check misclassified 6/14 technical neutral
examples as expressive (v1: 0/14). Add technical neutral examples before
considering deployment. The full training receipt, raw scores and report are in
`/srv/ai/benchmarks/avatar-attitude/training/2026-10-24-expanded-v2/`.

`ruri-v3-30m-speaking-attitude` implements the `choice` portion of `larm.system-one.v1`
for the fixed labels `none`, `warmth`, `joy`, `empathy`, `curiosity`, `surprise`.
The Gemma profile uses this Provider. ContextStill retains the general Laya Provider,
started on demand; its unconditional warm floor is zero. Laya weights remain installed.

The pinned `cl-nagoya/ruri-v3-30m` encoder (~37M parameters) runs on CPU via
ONNX Runtime 1.30.0 with dynamic per-channel INT8 MatMul/Gemm, four inference
threads, batch one and 512 tokens. Mean pooling and the trained linear head stay
FP32. There is no input embedding cache, conversation state, hysteresis or
cross-request smoothing. Startup verifies every external artifact hash and
performs ten warmups; an unexpected execution provider fails startup.

The head was fitted on **60 synthetic examples**, with C selected on a separate
36-example calibration set. A scalar temperature was subsequently fitted to
saved INT8 calibration logits using negative log likelihood. Evaluation labels
were used in neither fit. This is a **preliminary classifier**, not a classifier
trained on 300 human-reviewed real conversations. Its calibrated scores refer
to synthetic calibration data and do not establish real-world correctness probabilities.

Request example:

```json
{
  "model": "ruri-v3-30m-speaking-attitude",
  "state": {"current_chunk": "設定画面を開いてください。"},
  "questions": {
    "emotion": {
      "type": "choice",
      "instructions": "現在の回答をアシスタント自身が話す表情と声色",
      "criteria": {
        "none": "通常", "warmth": "親しみ", "joy": "喜び",
        "empathy": "寄り添い", "curiosity": "興味", "surprise": "驚き"
      }
    }
  }
}
```

State may also be a current-text string, or `{response: "...", conversation: "..."}`
for the existing consumer. `current_chunk` takes precedence over `response`.
Conversation/user/history fields never enter the encoder (input mode A, the exact
Japanese role tags and `トピック: ` prefix used during training). Caller-provided
instructions/descriptions cannot redefine the trained task. Refund intent,
`score`, `noul`, unnamed choices, unknown labels and wrong public models return 422.

Named candidate subsets must include `none`. Classification always scores all
six classes. When the best class is excluded, the answer abstains to `none` with
zero confidence; subset probabilities are never renormalized. The response saves
all six FP32 logits, temperature-scaled scores and calibration status. Truncation
is reported at the response top level to retain the strict System One usage
contract. Input longer than 512 tokens is truncated from the left, as in evaluation.
HTTP timing and inference timing are distinct; neither measures actual TTS onset.

## Preparing a reviewed dataset and classifier

All outputs must be outside this source repository. Use a new output directory
for each dataset/model revision; existing outputs are not overwritten.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/avatar-attitude/dataset.py \
  --data /path/to/reviewed.jsonl \
  --contract apps/ruri-system-one/contracts/expanded-v2.json \
  --reviewed-input \
  --output /srv/ai/benchmarks/avatar-attitude/datasets/reviewed-v2
```

`--reviewed-input` records a file-level review attestation when rows do not have
`review_status`; it does not invent per-row human approval. Explicit pending,
hold and rejected rows are excluded. Source records remain intact. `group`,
`template_group_id` and `template_group` are accepted template identities.
Conversation links, supplied groups, and normalized lexical similarity are
combined before splitting. Matches against the original evaluation partition
are pinned to evaluation. Every class must occur in all three partitions.
Outputs include `examples.jsonl`, `contract.json`, `audit.json` and a manifest of
hashes, IDs, groups, actual class counts, exclusions and split settings.

Use the pinned benchmark Python environment for training and evaluation:

```bash
PYTHONDONTWRITEBYTECODE=1 /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  benchmarks/avatar-attitude/train_head.py \
  --sandbox /srv/ai/benchmarks/avatar-attitude --model ruri30 \
  --data /srv/ai/benchmarks/avatar-attitude/datasets/reviewed-v2/examples.jsonl \
  --contract /srv/ai/benchmarks/avatar-attitude/datasets/reviewed-v2/contract.json \
  --onnx /srv/ai/benchmarks/avatar-attitude/onnx/ruri30-int8.onnx \
  --select-c --output /srv/ai/benchmarks/avatar-attitude/heads/reviewed-v2.json
```

Versioned contracts default to input A; legacy experiments retain A/B/C.
`--select-c` selects regularization using train-only
stratified group folds, retaining calibration for temperature/policy selection.
`run.py` takes the same `--data`, `--contract`, `--head` and `--onnx` identities;
use `--models ruri30 --method head` and a new `--output` run directory. It runs A
for versioned contracts and saves three independent timing repetitions. Pass
repetition-zero scores to `calibrate_head.py --scores ... --head ... --output ...`.
`report.py --runs ... --output ...` reports quality once per example, including
all classes, technical false expressions and anger/dislike misassignments.
Calibration scores are bound to the exact head, dataset and contract hashes.
Synthetic scores remain provisional; the report does not establish accuracy on
real conversation chunks. The legacy Laya comparator accepts only its six-label
contract; it is not silently included in a versioned comparison.

Package an evaluated candidate with the existing pinned encoder:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 deploy/local-node/scripts/package-ruri-artifacts.py \
  --head /path/to/new-head.json --calibration /path/to/new-calibration.json \
  --output /srv/ai/benchmarks/avatar-attitude/bundles/reviewed-v2
PYTHONDONTWRITEBYTECODE=1 python3 deploy/local-node/scripts/provision-ruri-artifacts.py \
  --bundle /srv/ai/benchmarks/avatar-attitude/bundles/reviewed-v2 \
  --target /srv/ai/models/ruri-speaking-attitude-v2
```

Packaging/installing does not activate a model or edit an Agent Profile. To load a
versioned package in an isolated process, explicitly set both `RURI_MODEL_ROOT`
and `RURI_ASSET_MANIFEST` (the installed package's `assets.json`). The manifest
binds the contract, encoder, tokenizer, head and calibration. Legacy model names
cannot select a versioned head. The existing unit continues to load v1 until a
separate release and consumer integration are completed.

Validation:

```bash
bun run test:avatar-attitude
bun run test:ruri-system-one
RURI_RUN_PIPELINE=1 PYTHONDONTWRITEBYTECODE=1 \
  /srv/ai/benchmarks/avatar-attitude/.venv/bin/python \
  -m unittest discover -s benchmarks/avatar-attitude -p 'test_*.py'
```

The opt-in integration uses test-only random text and the installed CPU encoder
to exercise import, training, three score repetitions, calibration, reporting,
packaging, installation and in-process inference. Temporary models are removed;
it does not train on attachments, change services or activate a release.

Preparation (unprivileged, outside the source tree):

```bash
bash deploy/local-node/scripts/prepare-ruri-runtime.sh
/srv/ai/apps/ruri-system-one/.venv/bin/python deploy/local-node/scripts/provision-ruri-artifacts.py
```

The provisioner accepts only the evaluated graph/head/calibration hashes in
`assets.json`; it refuses to overwrite a differing model revision. Base HF files
are tracked by `deploy/local-node/models.yaml`. Locally derived files are separate
and cannot be downloaded as if they were upstream HF weights.

Registration requires an administrator:

```bash
sudo bash deploy/local-node/scripts/install-ruri-service.sh
```

This installs only the new unit and its narrow start/stop permission; it does not
start or enable the Provider, replace credentials, remove Laya or activate a release.
After registration, use the existing signed release build/activation workflow for
a clean committed revision. The legacy-named `smoke-laya-profile.ts` now verifies
Gemma's Ruri attitude decision and credential revocation. Reacquire Gemma Agent Connections after activation. A daemon restart changes
the boot epoch and invalidates old credentials; a catalog update alone keeps
existing claims pinned to their original generation.
