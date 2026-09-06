from __future__ import annotations

import logging
import math
import os
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


def bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


MAX_BATCH_SIZE = bounded_int_env("QWEN_ASR_MAX_BATCH_SIZE", 1, 1, 32)
MAX_NEW_TOKENS = bounded_int_env("QWEN_ASR_MAX_NEW_TOKENS", 512, 1, 8192)
MAX_UPLOAD_BYTES = bounded_int_env("QWEN_ASR_MAX_UPLOAD_BYTES", 256 * 1024 * 1024, 1, 1024**3)
MAX_AUDIO_SECONDS = bounded_int_env("QWEN_ASR_MAX_AUDIO_SECONDS", 3600, 1, 24 * 3600)
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024

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
ALLOWED_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"}


class RequestBodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    def __init__(self, application, max_bytes: int, path: str):
        self.application = application
        self.max_bytes = max_bytes
        self.path = path

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != self.path:
            await self.application(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_bytes:
                    await self.reject(send)
                    return
            except ValueError:
                pass

        consumed = 0
        response_started = False

        async def limited_receive():
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.max_bytes:
                    raise RequestBodyTooLarge
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.application(scope, limited_receive, tracked_send)
        except RequestBodyTooLarge:
            if response_started:
                raise
            await self.reject(send)

    @staticmethod
    async def reject(send):
        body = b'{"detail":"request body too large"}'
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"connection", b"close"),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    return LANGUAGES.get(language.strip().lower(), language)


def copy_upload_limited(source, destination) -> int:
    total = 0
    while chunk := source.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"audio upload exceeds {MAX_UPLOAD_BYTES} bytes",
            )
        destination.write(chunk)
    return total


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
app.add_middleware(
    RequestBodyLimitMiddleware,
    max_bytes=MAX_REQUEST_BYTES,
    path="/v1/audio/transcriptions",
)


@app.get("/health")
def health(fail_on_no_slot: bool = False):
    body = {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_ID,
        "backend": "pytorch-rocm",
        "dtype": DTYPE_NAME,
        "max_new_tokens": MAX_NEW_TOKENS,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }
    if fail_on_no_slot and inference_lock.locked():
        body["status"] = "busy"
        return JSONResponse(body, status_code=503)
    return body


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
    if model is None:
        raise HTTPException(status_code=503, detail="ASR model is still loading")
    if len(model_name) > 256:
        raise HTTPException(status_code=400, detail="model is too long")
    if model_name not in {MODEL_ID, MODEL_PATH, "Qwen/Qwen3-ASR-1.7B"}:
        raise HTTPException(status_code=404, detail="unknown model")
    if len(response_format) > 32:
        raise HTTPException(status_code=400, detail="response_format is too long")
    if response_format not in {"json", "verbose_json", "text"}:
        raise HTTPException(status_code=400, detail="response_format must be json, verbose_json, or text")
    if language is not None and len(language) > 64:
        raise HTTPException(status_code=400, detail="language is too long")
    if prompt:
        raise HTTPException(status_code=400, detail="prompt is not supported")
    if not math.isfinite(temperature) or temperature != 0:
        raise HTTPException(status_code=400, detail="only temperature 0 is supported")

    suffix = Path(file.filename or "audio.wav").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        suffix = ".wav"
    temporary_path: Path | None = None
    lock_acquired = False
    try:
        lock_acquired = inference_lock.acquire(blocking=False)
        if not lock_acquired:
            raise HTTPException(
                status_code=429,
                detail="ASR provider is busy",
                headers={"Retry-After": "1"},
            )
        with tempfile.NamedTemporaryFile(dir=CACHE_DIR, suffix=suffix, delete=False) as temporary:
            uploaded_bytes = copy_upload_limited(file.file, temporary)
            temporary_path = Path(temporary.name)
        if uploaded_bytes == 0:
            raise HTTPException(status_code=400, detail="audio upload is empty")

        try:
            duration = sf.info(temporary_path).duration
        except Exception as exc:
            raise HTTPException(status_code=400, detail="audio file is invalid or unsupported") from exc
        if not math.isfinite(duration) or duration <= 0:
            raise HTTPException(status_code=400, detail="audio duration is invalid")
        if duration > MAX_AUDIO_SECONDS:
            raise HTTPException(
                status_code=413,
                detail=f"audio duration exceeds {MAX_AUDIO_SECONDS} seconds",
            )
        with torch.inference_mode():
            result = model.transcribe(
                audio=str(temporary_path),
                language=normalize_language(language),
            )[0]

        text = result.text.strip()
        detected_language = result.language.strip() if isinstance(result.language, str) else ""
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "verbose_json":
            response = {
                "task": "transcribe",
                "duration": duration,
                "text": text,
            }
            if detected_language:
                response["language"] = detected_language
            return JSONResponse(response)
        response = {"text": text}
        if detected_language:
            response["language"] = detected_language
        return JSONResponse(response)
    except HTTPException:
        raise
    except Exception as exc:
        LOGGER.exception("ASR inference failed")
        raise HTTPException(status_code=500, detail="ASR inference failed") from exc
    finally:
        if lock_acquired:
            inference_lock.release()
        file.file.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
