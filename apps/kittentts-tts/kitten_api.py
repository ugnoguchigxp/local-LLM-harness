"""Thin HTTP adapter for the pinned, external KittenTTS Nano FP32 engine."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import threading
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

MODEL = "kitten-tts-nano-0.8-fp32"
REVISION = "7a1db645b1f3ab9420761d87428e042b9cec3f26"
SAMPLE_RATE = 24000
VOICES = ("Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo")
PINNED_FILES = {
    "config.json": (688, "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64"),
    "kitten_tts_nano_v0_8.onnx": (56767095, "320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e"),
    "voices.npz": (3278902, "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f"),
}


def verify_files(root: Path) -> None:
    for name, (size, digest) in PINNED_FILES.items():
        path = root / name
        if not path.is_file() or path.stat().st_size != size:
            raise RuntimeError(f"Missing or wrong-sized pinned KittenTTS artifact: {name}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"KittenTTS artifact checksum mismatch: {name}")


def load_engine():
    root = Path(os.getenv("KITTENTTS_MODEL_ROOT", "/srv/ai/models/kittentts/fp32"))
    verify_files(root)
    threads = int(os.getenv("KITTENTTS_THREADS", "4"))
    if not 1 <= threads <= 32:
        raise RuntimeError("KITTENTTS_THREADS must be between 1 and 32")
    import onnxruntime as ort
    from kittentts.onnx_model import KittenTTS_1_Onnx

    config = json.loads((root / "config.json").read_text())
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    original_session = ort.InferenceSession

    def cpu_session(path):
        return original_session(path, sess_options=options, providers=["CPUExecutionProvider"])

    # The official 0.8.1 constructor has no SessionOptions argument. Set it only
    # during single-threaded startup, then restore the public ORT constructor.
    ort.InferenceSession = cpu_session
    try:
        engine = KittenTTS_1_Onnx(str(root / config["model_file"]), str(root / config["voices"]),
                                 config["speed_priors"], config["voice_aliases"])
    finally:
        ort.InferenceSession = original_session
    engine.generate("Ready.", voice="Rosie", clean_text=True)
    return engine


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    model: str = MODEL
    input: str = Field(min_length=1, max_length=4096)
    voice: str = "Rosie"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    response_format: str = "wav"


class BodyLimitMiddleware:
    def __init__(self, app, maximum: int = 65536):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/v1/audio/speech":
            return await self.app(scope, receive, send)
        # Buffer only the bounded JSON body, including requests without a length
        # header. Never synthesize an oversized request after consuming a prefix.
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            data = message.get("body", b"")
            size += len(data)
            if size > self.maximum:
                return await JSONResponse({"detail": "request body too large"}, status_code=413)(scope, receive, send)
            chunks.append(data)
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)


def create_app(engine_factory=load_engine) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        application.state.engine = engine_factory()
        yield
        application.state.engine = None

    application = FastAPI(lifespan=lifespan)
    application.state.engine = None
    synthesis_lock = threading.Lock()
    application.add_middleware(BodyLimitMiddleware)

    @application.get("/health")
    def health():
        ready = application.state.engine is not None
        return JSONResponse({"status": "ok" if ready else "starting", "ready": ready,
                             "model": MODEL, "revision": REVISION, "device": "cpu",
                             "sample_rate": SAMPLE_RATE}, status_code=200 if ready else 503)

    @application.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": MODEL, "object": "model", "created": 0, "owned_by": "kittenml"}]}

    @application.get("/v1/audio/voices")
    def voices(model: str = MODEL):
        if model != MODEL:
            raise HTTPException(404, "unknown speech model")
        return {"model": MODEL, "default_voice": "Rosie", "voices": [
            {"id": voice, "display_name": voice, "language": "en", "styles": [],
             "voice_presentation": "feminine" if index % 2 == 0 else "masculine",
             "capabilities": {"speed": {"minimum": 0.5, "maximum": 2.0, "default": 1.0}}}
            for index, voice in enumerate(VOICES)
        ]}

    @application.post("/v1/audio/speech")
    def speech(request: SpeechRequest):
        if request.model != MODEL:
            raise HTTPException(404, "unknown speech model")
        if request.voice not in VOICES:
            raise HTTPException(400, "unknown voice")
        if request.response_format not in ("wav", "pcm"):
            raise HTTPException(400, "supported response formats are wav and pcm")
        text = request.input.strip()
        if not re.search(r"[A-Za-z0-9]", text) or re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", text):
            raise HTTPException(400, "KittenTTS Nano accepts English text; select a Japanese provider for Japanese")
        engine = application.state.engine
        if engine is None:
            raise HTTPException(503, "speech model is starting", headers={"Retry-After": "1"})
        if not synthesis_lock.acquire(blocking=False):
            raise HTTPException(429, "speech provider is busy", headers={"Retry-After": "1"})
        try:
            # Serialize Espeak as well as ORT; its shared frontend has not been
            # verified for thread safety. Normalize numbers before chunking.
            audio = np.asarray(engine.generate(text, voice=request.voice, speed=request.speed, clean_text=True)).reshape(-1)
            if not audio.size or not np.isfinite(audio).all():
                raise HTTPException(502, "speech model produced invalid audio")
            peak = float(np.max(np.abs(audio)))
            if peak > 0.98:
                audio = audio * (0.98 / peak)
            pcm = np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
            if request.response_format == "pcm":
                return Response(pcm, media_type="audio/pcm")
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(SAMPLE_RATE)
                wav.writeframes(pcm)
            return Response(output.getvalue(), media_type="audio/wav")
        finally:
            synthesis_lock.release()

    return application


app = create_app()
