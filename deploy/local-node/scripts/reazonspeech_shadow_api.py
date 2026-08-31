"""Evaluation-only OpenAI-compatible endpoint for ReazonSpeech-k2-v2.

The sherpa-onnx runtime and model artifacts deliberately live outside this
source repository. This process is intended for attended shadow benchmarks;
it is not installed as a systemd service or added to a production route.
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile


MODEL_ROOT = Path(os.environ.get("REAZON_MODEL_ROOT", "/srv/ai/models/reazonspeech-k2-v2"))
THREADS = int(os.environ.get("REAZON_THREADS", "4"))
MAX_UPLOAD_BYTES = int(os.environ.get("REAZON_MAX_UPLOAD_BYTES", str(32 * 1024 * 1024)))

if THREADS < 1 or THREADS > 32:
    raise RuntimeError("REAZON_THREADS must be between 1 and 32")
if MAX_UPLOAD_BYTES < 1 or MAX_UPLOAD_BYTES > 256 * 1024 * 1024:
    raise RuntimeError("REAZON_MAX_UPLOAD_BYTES must be between 1 and 268435456")

FILES = {
    "tokens": MODEL_ROOT / "tokens.txt",
    "encoder": MODEL_ROOT / "encoder-epoch-99-avg-1.int8.onnx",
    "decoder": MODEL_ROOT / "decoder-epoch-99-avg-1.onnx",
    "joiner": MODEL_ROOT / "joiner-epoch-99-avg-1.onnx",
}
missing = [str(path) for path in FILES.values() if not path.is_file()]
if missing:
    raise RuntimeError(f"ReazonSpeech model files missing: {', '.join(missing)}")

recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    tokens=str(FILES["tokens"]),
    encoder=str(FILES["encoder"]),
    decoder=str(FILES["decoder"]),
    joiner=str(FILES["joiner"]),
    num_threads=THREADS,
    sample_rate=16_000,
    feature_dim=80,
    decoding_method="greedy_search",
    provider="cpu",
)
recognizer_lock = threading.Lock()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "model": "reazonspeech-k2-v2-int8-fp32",
        "provider": "cpu",
        "threads": THREADS,
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
    mono = np.asarray(samples.mean(axis=1), dtype=np.float32)
    if not np.isfinite(mono).all():
        raise HTTPException(status_code=400, detail="non-finite audio samples")

    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, mono)
    with recognizer_lock:
        recognizer.decode_stream(stream)
    return {"text": stream.result.text}
