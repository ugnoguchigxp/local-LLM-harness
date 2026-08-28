from __future__ import annotations

import io
import os
import threading
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile


RUNTIME_ROOT = Path(os.environ["VOICEVOX_RUNTIME_ROOT"])
ONNXRUNTIME_PATH = RUNTIME_ROOT / "onnxruntime/lib/libvoicevox_onnxruntime.so.1.17.3"
DICT_PATH = RUNTIME_ROOT / "dict/open_jtalk_dic_utf_8-1.11"
VVM_PATH = RUNTIME_ROOT / "models/vvms/0.vvm"
CPU_THREADS = int(os.getenv("VOICEVOX_THREADS", "16"))
DEFAULT_VOICE = os.getenv("VOICEVOX_DEFAULT_VOICE", "Kasukabe_Tsumugi")

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

synthesizer: Synthesizer | None = None
synthesis_lock = threading.Lock()


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


def wav_to_pcm(wav_bytes: bytes) -> bytes:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        if wav_file.getsampwidth() != 2 or wav_file.getnchannels() != 1:
            raise RuntimeError("Unexpected VOICEVOX output format")
        return wav_file.readframes(wav_file.getnframes())


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


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "healthy" if synthesizer is not None else "starting",
        "backend": "voicevox-core-cpu",
        "version": "0.17.0",
        "threads": CPU_THREADS,
        "default_voice": DEFAULT_VOICE,
        "voices": VOICE_STYLES,
        "native_streaming": False,
    }


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
    style_id, voice_name = resolve_style(request.voice)
    with synthesis_lock:
        query = synthesizer.create_audio_query(request.input, style_id)
        query.speed_scale = request.speed
        wav_bytes = synthesizer.synthesis(query, style_id)
    credit_header = f"VOICEVOX:{voice_name}"
    if request.response_format == "pcm":
        return Response(
            content=wav_to_pcm(wav_bytes),
            media_type="audio/L16;rate=24000;channels=1",
            headers={
                "X-VOICEVOX-Credit": credit_header,
                "X-Audio-Sample-Rate": "24000",
            },
        )
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-VOICEVOX-Credit": credit_header},
    )
