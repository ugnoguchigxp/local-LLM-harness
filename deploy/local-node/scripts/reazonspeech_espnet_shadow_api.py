"""Evaluation-only OpenAI-compatible endpoint for ReazonSpeech ESPnet v2.

The ESPnet runtime, virtual environment, and model artifacts deliberately live
outside this source repository. This process is intended for attended ROCm
shadow benchmarks; it is not installed as a service or added to a production
route.
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch
from espnet2.bin.asr_inference import Speech2Text
from fastapi import FastAPI, File, HTTPException, UploadFile


MODEL_ROOT = Path(
    os.environ.get("REAZON_ESPNET_MODEL_ROOT", "/srv/ai/models/reazonspeech-espnet-v2")
)
DEVICE = os.environ.get("REAZON_ESPNET_DEVICE", "cuda")
DTYPE = os.environ.get("REAZON_ESPNET_DTYPE", "float32")
BEAM_SIZE = int(os.environ.get("REAZON_ESPNET_BEAM_SIZE", "20"))
MAX_UPLOAD_BYTES = int(
    os.environ.get("REAZON_ESPNET_MAX_UPLOAD_BYTES", str(32 * 1024 * 1024))
)
MAX_DURATION_SECONDS = float(os.environ.get("REAZON_ESPNET_MAX_DURATION_SECONDS", "30"))
SAMPLE_RATE = 16_000
PADDING = (SAMPLE_RATE, SAMPLE_RATE // 2)

if DEVICE not in {"cpu", "cuda"}:
    raise RuntimeError("REAZON_ESPNET_DEVICE must be cpu or cuda")
if DEVICE == "cuda" and not torch.cuda.is_available():
    raise RuntimeError("REAZON_ESPNET_DEVICE=cuda but PyTorch cannot access ROCm")
if DTYPE not in {"float16", "float32"}:
    raise RuntimeError("REAZON_ESPNET_DTYPE must be float16 or float32")
if BEAM_SIZE < 1 or BEAM_SIZE > 100:
    raise RuntimeError("REAZON_ESPNET_BEAM_SIZE must be between 1 and 100")
if MAX_UPLOAD_BYTES < 1 or MAX_UPLOAD_BYTES > 256 * 1024 * 1024:
    raise RuntimeError("REAZON_ESPNET_MAX_UPLOAD_BYTES must be between 1 and 268435456")
if MAX_DURATION_SECONDS <= 0 or MAX_DURATION_SECONDS > 300:
    raise RuntimeError("REAZON_ESPNET_MAX_DURATION_SECONDS must be in (0, 300]")

ASR_CONFIG = MODEL_ROOT / "exp/asr_train_asr_conformer_raw_jp_char/config.yaml"
ASR_MODEL = MODEL_ROOT / "exp/asr_train_asr_conformer_raw_jp_char/valid.acc.ave_10best.pth"
missing = [str(path) for path in (ASR_CONFIG, ASR_MODEL) if not path.is_file()]
if missing:
    raise RuntimeError(f"ReazonSpeech ESPnet model files missing: {', '.join(missing)}")

previous_working_directory = Path.cwd()
try:
    # The upstream config deliberately records its normalization statistics
    # relative to the pinned snapshot root.
    os.chdir(MODEL_ROOT)
    recognizer = Speech2Text(
        asr_train_config=ASR_CONFIG,
        asr_model_file=ASR_MODEL,
        device=DEVICE,
        dtype=DTYPE,
        beam_size=BEAM_SIZE,
        lm_weight=0,
    )
finally:
    os.chdir(previous_working_directory)
recognizer_lock = threading.Lock()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "model": "reazonspeech-espnet-v2",
        "provider": "pytorch-rocm" if DEVICE == "cuda" else "pytorch-cpu",
        "device": DEVICE,
        "dtype": DTYPE,
        "beamSize": BEAM_SIZE,
        "externalLm": False,
    }


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...)) -> dict[str, str]:
    payload = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not payload or len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio upload is empty or too large")
    try:
        samples, sample_rate = sf.read(io.BytesIO(payload), dtype="float32", always_2d=True)
    except (RuntimeError, TypeError, ValueError) as cause:
        raise HTTPException(status_code=400, detail="unsupported audio") from cause
    if samples.shape[0] == 0 or sample_rate <= 0:
        raise HTTPException(status_code=400, detail="empty audio")

    duration_seconds = samples.shape[0] / sample_rate
    if duration_seconds > MAX_DURATION_SECONDS:
        raise HTTPException(status_code=413, detail="audio duration exceeds limit")
    mono = np.asarray(samples.mean(axis=1), dtype=np.float32)
    if sample_rate != SAMPLE_RATE:
        mono = np.asarray(
            librosa.resample(mono, orig_sr=sample_rate, target_sr=SAMPLE_RATE),
            dtype=np.float32,
        )
    if not np.isfinite(mono).all():
        raise HTTPException(status_code=400, detail="non-finite audio samples")

    padded = np.pad(mono, PADDING, mode="constant")
    with recognizer_lock, torch.inference_mode():
        text = recognizer(padded)[0][0]
    return {"text": text}
