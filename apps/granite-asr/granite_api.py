"""Persistent Granite Speech 4.1 HTTP provider for short voice dialogue."""
from __future__ import annotations

import asyncio
import io
import math
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import transcribe_cpp as tc
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

MODEL_ID = "granite-speech-4.1-2b"
MODEL_PATH = os.environ.get("GRANITE_ASR_MODEL", "/srv/ai/models/granite-asr/granite-speech-4.1-2b-Q8_0.gguf")
MAX_UPLOAD_BYTES = 16 * 1024 * 1024
MAX_AUDIO_SECONDS = 12
QUEUE_TIMEOUT_SECONDS = 2
inference_lock = threading.Lock()
pending_lock = threading.Lock()
native_model = None
session = None
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="granite-asr")


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/v1/audio/transcriptions":
            return await self.app(scope, receive, send)
        limit = MAX_UPLOAD_BYTES + 1024 * 1024
        length = dict(scope.get("headers", [])).get(b"content-length")
        if length and length.isdigit() and int(length) > limit:
            return await JSONResponse({"detail": "request body too large"}, status_code=413)(scope, receive, send)
        consumed = 0

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message["type"] == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > limit:
                    raise HTTPException(413, "request body too large")
            return message

        return await self.app(scope, bounded_receive, send)


@asynccontextmanager
async def lifespan(_):
    global native_model, session
    native_model = tc.Model(MODEL_PATH, backend="vulkan")
    if native_model.device.kind != "vulkan":
        native_model.close()
        raise RuntimeError("Granite dialogue provider requires the Vulkan backend")
    session = native_model.session(n_threads=16, n_ctx=512)
    try:
        yield
    finally:
        executor.shutdown(wait=True)
        session.close()
        native_model.close()
        session = native_model = None


app = FastAPI(title="Granite 4.1 dialogue provider", lifespan=lifespan)
app.add_middleware(BodyLimit)


@app.get("/health")
def health(fail_on_no_slot: bool = False):
    busy = inference_lock.locked()
    body = {"status": "ok" if session is not None else "loading", "model": MODEL_ID,
            "backend": "transcribe.cpp-vulkan", "quantization": "Q8_0", "busy": busy,
            "max_audio_seconds": MAX_AUDIO_SECONDS}
    if busy and fail_on_no_slot:
        body["status"] = "busy"
        return JSONResponse(body, status_code=503)
    return body


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "IBM"}]}


def decode_audio(data: bytes):
    try:
        info = sf.info(io.BytesIO(data))
        duration = info.duration
        if not math.isfinite(duration) or duration <= 0:
            raise HTTPException(400, "audio duration is invalid")
        if duration > MAX_AUDIO_SECONDS:
            raise HTTPException(413, "audio duration exceeds 12 seconds")
        if not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
            raise HTTPException(400, "unsupported audio sample rate or channel count")
        pcm, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "audio file is invalid or unsupported") from exc
    if not np.isfinite(pcm).all():
        raise HTTPException(400, "audio contains invalid samples")
    pcm = pcm.mean(axis=1)
    if rate != 16000:
        try:
            converted = subprocess.run([
                "/usr/bin/ffmpeg", "-v", "error", "-threads", "1", "-f", "f32le", "-ar", str(rate),
                "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1",
            ], input=pcm.astype("<f4").tobytes(), capture_output=True, check=True, timeout=10)
        except (subprocess.SubprocessError, OSError) as exc:
            raise HTTPException(400, "audio conversion failed") from exc
        pcm = np.frombuffer(converted.stdout, dtype="<f4")
    return np.ascontiguousarray(pcm, dtype=np.float32), duration


async def acquire_slot(request: Request):
    if inference_lock.acquire(blocking=False):
        return
    if not pending_lock.acquire(blocking=False):
        raise HTTPException(429, "ASR provider is busy", headers={"Retry-After": "1"})
    try:
        deadline = time.monotonic() + QUEUE_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if await request.is_disconnected():
                raise HTTPException(499, "request cancelled")
            if inference_lock.acquire(blocking=False):
                return
            await asyncio.sleep(0.02)
        raise HTTPException(429, "ASR provider is busy", headers={"Retry-After": "1"})
    finally:
        pending_lock.release()


def recognize(data, language):
    pcm, duration = decode_audio(data)
    # Avoid hallucinated subtitles on the control plane's silence readiness probe.
    if np.max(np.abs(pcm)) < 1e-5:
        return "", duration
    result = session.run(pcm, language=language, timestamps="none")
    return result.text, duration


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    request: Request, file: UploadFile = File(...), model: str = Form(MODEL_ID),
    language: str | None = Form(None), response_format: str = Form("json"),
    prompt: str | None = Form(None), temperature: float = Form(0),
):
    if session is None:
        raise HTTPException(503, "ASR model is still loading")
    if model not in {MODEL_ID, "ibm-granite/granite-speech-4.1-2b"}:
        raise HTTPException(404, "unknown model")
    if response_format not in {"json", "text", "verbose_json"}:
        raise HTTPException(400, "response_format must be json, text, or verbose_json")
    if language and language.lower() not in {"auto", "ja", "japanese", "en", "english"}:
        raise HTTPException(400, "this dialogue provider supports Japanese and English")
    if prompt:
        raise HTTPException(400, "prompt is not supported")
    if not math.isfinite(temperature) or temperature != 0:
        raise HTTPException(400, "only temperature 0 is supported")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if not data:
        raise HTTPException(400, "audio upload is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "audio upload is too large")
    await acquire_slot(request)
    future = None
    disconnected = False
    try:
        future = executor.submit(recognize, data, None if not language or language.lower() == "auto" else language)
        while not future.done():
            if await request.is_disconnected():
                disconnected = True
            if disconnected:
                session.cancel()
            await asyncio.sleep(0.02)
        if disconnected:
            raise HTTPException(499, "request cancelled")
        try:
            text, duration = future.result()
        except tc.Aborted as exc:
            raise HTTPException(499, "request cancelled") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, "ASR inference failed") from exc
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "verbose_json":
            return {"text": text, "task": "transcribe", "duration": duration, "segments": []}
        return {"text": text}
    finally:
        # Keep the slot until the native worker really stops, including ASGI cancellation.
        if future is not None and not future.done():
            async def drain():
                while not future.done():
                    session.cancel()
                    await asyncio.sleep(0.02)
            drain_task = asyncio.create_task(drain())
            try:
                await asyncio.shield(drain_task)
            except asyncio.CancelledError:
                # Shutdown must not admit another request onto the same live session.
                await drain_task
        inference_lock.release()
