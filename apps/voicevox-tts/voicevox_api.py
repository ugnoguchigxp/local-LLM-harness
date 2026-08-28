from __future__ import annotations

import io
import os
import threading
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile


RUNTIME_ROOT = Path(os.environ["VOICEVOX_RUNTIME_ROOT"])
ONNXRUNTIME_PATH = RUNTIME_ROOT / "onnxruntime/lib/libvoicevox_onnxruntime.so.1.17.3"
DICT_PATH = RUNTIME_ROOT / "dict/open_jtalk_dic_utf_8-1.11"
VVM_PATH = RUNTIME_ROOT / "models/vvms/0.vvm"


def bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


CPU_THREADS = bounded_int_env("VOICEVOX_THREADS", 16, 1, 256)
DEFAULT_VOICE = os.getenv("VOICEVOX_DEFAULT_VOICE", "Kasukabe_Tsumugi")
MAX_REQUEST_BYTES = bounded_int_env("VOICEVOX_MAX_REQUEST_BYTES", 64 * 1024, 1, 1024 * 1024)

VOICE_STYLES = {
    "Shikoku_Metan": 2,
    "Zundamon": 3,
    "Kasukabe_Tsumugi": 8,
    "Amehare_Hau": 10,
}
VOICE_CREDITS = {
    "Shikoku_Metan": "VOICEVOX:四国めたん",
    "Zundamon": "VOICEVOX:ずんだもん",
    "Kasukabe_Tsumugi": "VOICEVOX:春日部つむぎ",
    "Amehare_Hau": "VOICEVOX:雨晴はう",
}
if DEFAULT_VOICE not in VOICE_STYLES:
    raise RuntimeError(f"unsupported VOICEVOX_DEFAULT_VOICE: {DEFAULT_VOICE}")

synthesizer: Synthesizer | None = None
synthesis_lock = threading.Lock()


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


class SpeechRequest(BaseModel):
    model: str = "voicevox-core"
    input: str = Field(min_length=1, max_length=4096)
    voice: str = DEFAULT_VOICE
    response_format: Literal["wav", "pcm"] = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    stream: bool = False
    language: str | None = "ja"
    instruct: str | None = None


def resolve_style(voice: str) -> tuple[int, str]:
    if voice in VOICE_STYLES:
        return VOICE_STYLES[voice], voice
    try:
        style_id = int(voice)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice. Available voices: {', '.join(VOICE_STYLES)}",
        ) from error
    for name, candidate_id in VOICE_STYLES.items():
        if candidate_id == style_id:
            return style_id, name
    raise HTTPException(status_code=400, detail=f"Unsupported style id: {style_id}")


def wav_to_pcm(wav_bytes: bytes) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        if (
            wav_file.getsampwidth() != 2
            or wav_file.getnchannels() != 1
            or wav_file.getcomptype() != "NONE"
        ):
            raise RuntimeError("Unexpected VOICEVOX output format")
        return wav_file.readframes(wav_file.getnframes()), wav_file.getframerate()


def encode_credit_header(credit: str) -> str:
    return "UTF-8''" + quote(credit, safe="")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global synthesizer
    runtime = Onnxruntime.load_once(filename=str(ONNXRUNTIME_PATH))
    instance = Synthesizer(
        runtime,
        OpenJtalk(DICT_PATH),
        acceleration_mode="CPU",
        cpu_num_threads=CPU_THREADS,
    )
    with VoiceModelFile.open(VVM_PATH) as voice_model:
        instance.load_voice_model(voice_model)
    synthesizer = instance
    yield
    synthesizer = None


app = FastAPI(title="VOICEVOX CORE low-contention TTS", version="0.17.0", lifespan=lifespan)
app.add_middleware(
    RequestBodyLimitMiddleware,
    max_bytes=MAX_REQUEST_BYTES,
    path="/v1/audio/speech",
)


@app.get("/health")
def health(fail_on_no_slot: bool = False):
    body = {
        "status": "healthy" if synthesizer is not None else "starting",
        "backend": "voicevox-core-cpu",
        "version": "0.17.0",
        "threads": CPU_THREADS,
        "default_voice": DEFAULT_VOICE,
        "voices": VOICE_STYLES,
        "native_streaming": False,
    }
    if fail_on_no_slot and synthesis_lock.locked():
        body["status"] = "busy"
        return JSONResponse(body, status_code=503)
    return body


@app.get("/v1/models")
def models() -> dict[str, object]:
    return {"object": "list", "data": [{"id": "voicevox-core", "object": "model"}]}


@app.get("/v1/audio/voices")
def voices() -> dict[str, object]:
    return {
        "voices": [
            {"name": name, "style_id": style_id, "credit": VOICE_CREDITS[name]}
            for name, style_id in VOICE_STYLES.items()
        ]
    }


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest) -> Response:
    if request.model not in {"voicevox-core", "tts-1", "tts-1-hd"}:
        raise HTTPException(status_code=400, detail="Unsupported model")
    if synthesizer is None:
        raise HTTPException(status_code=503, detail="Synthesizer is starting")
    if request.stream:
        raise HTTPException(status_code=400, detail="Native streaming is not supported")
    if request.language not in {None, "ja", "japanese", "Japanese"}:
        raise HTTPException(status_code=400, detail="VOICEVOX only supports Japanese")
    if request.instruct:
        raise HTTPException(status_code=400, detail="VOICEVOX does not support instruct")
    style_id, voice_name = resolve_style(request.voice)
    if not synthesis_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="VOICEVOX provider is busy",
            headers={"Retry-After": "1"},
        )
    try:
        query = synthesizer.create_audio_query(request.input, style_id)
        query.speed_scale = request.speed
        wav_bytes = synthesizer.synthesis(query, style_id)
    finally:
        synthesis_lock.release()
    credit_header = encode_credit_header(VOICE_CREDITS[voice_name])
    if request.response_format == "pcm":
        pcm_bytes, sample_rate = wav_to_pcm(wav_bytes)
        return Response(
            content=pcm_bytes,
            media_type=f"audio/pcm;rate={sample_rate};channels=1;format=s16le",
            headers={
                "X-VOICEVOX-Credit": credit_header,
                "X-Audio-Sample-Rate": str(sample_rate),
                "X-Audio-Sample-Format": "s16le",
            },
        )
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-VOICEVOX-Credit": credit_header},
    )
