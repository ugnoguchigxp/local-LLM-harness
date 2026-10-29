# Ruri shared speaking-attitude and user-intent Provider

`model` selects either `ruri-v3-30m-speaking-attitude` or
`ruri-v3-30m-user-intent-v1` on `POST /v1/systemone`. Both heads are verified,
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
  "model": "ruri-v3-30m-user-intent-v1",
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
