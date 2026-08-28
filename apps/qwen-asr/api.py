from __future__ import annotations

import logging
import os
import shutil
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from qwen_asr import Qwen3ASRModel


LOGGER = logging.getLogger("qwen-asr-api")
MODEL_PATH = os.getenv("QWEN_ASR_MODEL", "/srv/ai/models/qwen-asr/Qwen3-ASR-1.7B")
MODEL_ID = os.getenv("QWEN_ASR_MODEL_ID", "qwen3-asr-1.7b")
CACHE_DIR = Path(os.getenv("QWEN_SPEECH_CACHE", "/srv/ai/cache/qwen-speech"))
DTYPE_NAME = os.getenv("QWEN_ASR_DTYPE", "float16").lower()
MAX_BATCH_SIZE = int(os.getenv("QWEN_ASR_MAX_BATCH_SIZE", "1"))
MAX_NEW_TOKENS = int(os.getenv("QWEN_ASR_MAX_NEW_TOKENS", "512"))

DTYPES = {
    "bfloat16": torch.bfloat16,
    "bf16": torch.bfloat16,
    "float16": torch.float16,
    "fp16": torch.float16,
}
if DTYPE_NAME not in DTYPES:
    raise RuntimeError(f"unsupported QWEN_ASR_DTYPE: {DTYPE_NAME}")

LANGUAGES = {
    "auto": None,
    "ja": "Japanese",
    "japanese": "Japanese",
    "en": "English",
    "english": "English",
    "zh": "Chinese",
    "chinese": "Chinese",
    "ko": "Korean",
    "korean": "Korean",
}

model: Qwen3ASRModel | None = None
inference_lock = threading.Lock()


def normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    return LANGUAGES.get(language.strip().lower(), language)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    torch.backends.cudnn.benchmark = False
    LOGGER.info("loading ASR model from %s", MODEL_PATH)
    model = Qwen3ASRModel.from_pretrained(
        MODEL_PATH,
        dtype=DTYPES[DTYPE_NAME],
        device_map="cuda:0",
        attn_implementation="sdpa",
        max_inference_batch_size=MAX_BATCH_SIZE,
        max_new_tokens=MAX_NEW_TOKENS,
    )
    LOGGER.info("ASR model ready on %s", torch.cuda.get_device_name(0))
    yield
    model = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


app = FastAPI(title="Qwen3 ASR Provider", version="1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_ID,
        "backend": "pytorch-rocm",
        "dtype": DTYPE_NAME,
        "max_new_tokens": MAX_NEW_TOKENS,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.get("/v1/models")
def models() -> dict[str, object]:
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "owned_by": "Qwen"}],
    }


@app.post("/v1/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form(MODEL_ID, alias="model"),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    prompt: str | None = Form(None),
    temperature: float = Form(0.0),
):
    del prompt, temperature
    if model is None:
        raise HTTPException(status_code=503, detail="ASR model is still loading")
    if model_name not in {MODEL_ID, MODEL_PATH, "Qwen/Qwen3-ASR-1.7B"}:
        raise HTTPException(status_code=404, detail=f"unknown model: {model_name}")
    if response_format not in {"json", "verbose_json", "text"}:
        raise HTTPException(status_code=400, detail="response_format must be json, verbose_json, or text")

    suffix = Path(file.filename or "audio.wav").suffix.lower()
    if not suffix or len(suffix) > 8:
        suffix = ".wav"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=CACHE_DIR, suffix=suffix, delete=False) as temporary:
            shutil.copyfileobj(file.file, temporary)
            temporary_path = Path(temporary.name)

        duration = sf.info(temporary_path).duration
        with inference_lock, torch.inference_mode():
            result = model.transcribe(
                audio=str(temporary_path),
                language=normalize_language(language),
            )[0]

        text = result.text.strip()
        detected_language = result.language
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "verbose_json":
            return JSONResponse(
                {
                    "task": "transcribe",
                    "language": detected_language,
                    "duration": duration,
                    "text": text,
                }
            )
        return JSONResponse({"text": text, "language": detected_language})
    except HTTPException:
        raise
    except Exception as exc:
        LOGGER.exception("ASR inference failed")
        raise HTTPException(status_code=500, detail=f"ASR inference failed: {exc}") from exc
    finally:
        file.file.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
