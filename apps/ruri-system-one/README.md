# Ruri speaking-attitude Provider

The same resident CPU encoder now serves `ruri-v3-30m-sentence-language`
through the `sentence-language` Provider (`decision.sentence-language`,
route `system-one-ruri-language`). Both routes resolve to `ruri-system-one`.
There is one ONNX session, loaded once, and a separately pinned ja/en head.
The previous attitude input format and head are unchanged.

Language requests use the existing `/v1/systemone` choice envelope, with
`state` containing a sentence and named criteria `{ja: "日本語文章", en: "英語文章"}`.
Both candidates are required. `answers.<question>.choice` is `ja` or `en`.
It classifies the whole sentence, not individual language spans or pauses.
Empty input, unsupported questions, and >512 tokens return 422; language
input is never silently truncated. Acquire the `sentence-language` provider
from `SAAA-gemma4-26b` rather than changing an attitude claim's model.

`provision-ruri-artifacts.py` also installs the evaluated head in
`/srv/ai/models/ruri-sentence-language-v1` (head SHA-256
`aa0ec854481c88e421711824c4082ba45f7ac21006bd5f3343f6064a4321e289`).
The optional `RURI_LANGUAGE_MODEL_ROOT` selects its artifact root. Startup
checks encoder/tokenizer hashes against both manifests before sharing them.
`/health` retains the attitude fields and adds `models`,
`encoder_session_count: 1`, and `sentence_language` details.
Use `smoke-ruri-language-profile.ts` for claimed ja/en classification, old
attitude, cross-model rejection, renewal, revocation and warm HTTP timings.

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
