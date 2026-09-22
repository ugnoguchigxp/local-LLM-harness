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
VVM_DIR = RUNTIME_ROOT / "models/vvms"


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

VOICE_OVERRIDES = {
    "7ffcb7ce-00ec-4bdc-82cd-45a8889e43ff": {
        "id": "Shikoku_Metan",
        "presentation": "feminine",
        "credit": "VOICEVOX:四国めたん",
    },
    "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9": {
        "id": "Zundamon",
        "presentation": "androgynous",
        "credit": "VOICEVOX:ずんだもん",
    },
    "35b2c544-660e-401e-b503-0e14c635303a": {
        "id": "Kasukabe_Tsumugi",
        "presentation": "feminine",
        "credit": "VOICEVOX:春日部つむぎ",
    },
    "3474ee95-c274-47f9-aa1a-8322163d96f1": {
        "id": "Amehare_Hau",
        "presentation": "feminine",
        "credit": "VOICEVOX:雨晴はう",
    },
}
VOICE_NAME_OVERRIDES = {
    "玄野武宏": {
        "id": "Kurono_Takehiro",
        "presentation": "masculine",
        "credit": "VOICEVOX:玄野武宏",
    },
    "剣崎雌雄": {
        "id": "Kenzaki_Mesuo",
        "presentation": "masculine",
        "credit": "VOICEVOX:剣崎雌雄",
    },
}
STYLE_ALIASES = {
    "ノーマル": "normal",
    "あまあま": "sweet",
    "甘々": "sweet",
    "ツンツン": "tsuntsun",
    "セクシー": "sexy",
    "ささやき": "whisper",
    "ヒソヒソ": "soft-whisper",
}


def configured_vvm_paths() -> tuple[list[Path], list[str]]:
    names = [value.strip() for value in os.getenv("VOICEVOX_VVM_FILES", "0.vvm").split(",")]
    if not names or any(not name for name in names):
        raise RuntimeError("VOICEVOX_VVM_FILES must contain comma-separated VVM filenames")
    optional_names = [
        value.strip()
        for value in os.getenv("VOICEVOX_OPTIONAL_VVM_FILES", "").split(",")
        if value.strip()
    ]
    paths: list[Path] = []
    seen_names: set[str] = set()
    missing_optional: list[str] = []
    for name, required in [(value, True) for value in names] + [
        (value, False) for value in optional_names
    ]:
        if Path(name).name != name or not name.endswith(".vvm"):
            raise RuntimeError("VOICEVOX VVM entries must be plain .vvm filenames")
        if name in seen_names:
            raise RuntimeError(f"duplicate VOICEVOX VVM file: {name}")
        seen_names.add(name)
        path = VVM_DIR / name
        if path.is_symlink():
            raise RuntimeError(f"VOICEVOX VVM file must not be a symlink: {name}")
        if not path.is_file():
            if required:
                raise RuntimeError(f"required VOICEVOX VVM file is missing: {name}")
            missing_optional.append(name)
            continue
        paths.append(path)
    return paths, missing_optional


VVM_PATHS, MISSING_OPTIONAL_VVMS = configured_vvm_paths()

synthesizer: Synthesizer | None = None
synthesis_lock = threading.Lock()
voice_catalog: dict[str, dict[str, object]] = {}
style_owners: dict[int, str] = {}


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
    style: str | int | None = None
    response_format: Literal["wav", "pcm"] = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    pitch_scale: float = Field(default=0.0, ge=-0.15, le=0.15)
    intonation_scale: float = Field(default=1.0, ge=0.0, le=2.0)
    stream: bool = False
    language: str | None = "ja"
    instruct: str | None = None


def style_alias(name: str, style_id: int) -> str:
    return STYLE_ALIASES.get(name, f"style-{style_id}")


def rebuild_voice_catalog(instance: Synthesizer) -> None:
    global voice_catalog, style_owners
    rebuilt: dict[str, dict[str, object]] = {}
    owners: dict[int, str] = {}
    for character in instance.metas():
        override = VOICE_OVERRIDES.get(
            character.speaker_uuid,
            VOICE_NAME_OVERRIDES.get(character.name, {}),
        )
        voice_id = str(override.get("id", character.speaker_uuid))
        presentation = str(override.get("presentation", "unspecified"))
        if presentation not in {"masculine", "feminine", "androgynous", "unspecified"}:
            raise RuntimeError(f"invalid voice presentation for {voice_id}")
        credit = str(override.get("credit", f"VOICEVOX:{character.name}"))
        if not voice_id or not credit:
            raise RuntimeError(f"invalid VOICEVOX metadata for {character.name}")
        styles: list[dict[str, object]] = []
        seen_aliases: set[str] = set()
        for style in character.styles:
            if style.type != "talk":
                continue
            alias = style_alias(style.name, style.id)
            if alias in seen_aliases:
                alias = f"{alias}-{style.id}"
            seen_aliases.add(alias)
            if style.id in owners and owners[style.id] != voice_id:
                raise RuntimeError(f"VOICEVOX style id {style.id} belongs to multiple voices")
            owners[style.id] = voice_id
            styles.append({"id": alias, "display_name": style.name, "style_id": style.id})
        if not styles:
            continue
        default_style = next((value for value in styles if value["id"] == "normal"), styles[0])
        if voice_id in rebuilt:
            existing = rebuilt[voice_id]
            if existing["speaker_uuid"] != character.speaker_uuid:
                raise RuntimeError(f"VOICEVOX voice id {voice_id} belongs to multiple speakers")
            existing_styles = existing["styles"]
            if not isinstance(existing_styles, list):
                raise RuntimeError("VOICEVOX voice catalog is inconsistent")
            known_ids = {int(value["style_id"]) for value in existing_styles}
            known_aliases = {str(value["id"]) for value in existing_styles}
            for value in styles:
                if int(value["style_id"]) in known_ids:
                    continue
                if str(value["id"]) in known_aliases:
                    value["id"] = f"{value['id']}-{value['style_id']}"
                known_ids.add(int(value["style_id"]))
                known_aliases.add(str(value["id"]))
                existing_styles.append(value)
                if value["id"] == "normal" and existing["default_style"] != "normal":
                    existing["default_style"] = "normal"
                    existing["style_id"] = value["style_id"]
            continue
        rebuilt[voice_id] = {
            "id": voice_id,
            "name": voice_id,
            "display_name": character.name,
            "speaker_uuid": character.speaker_uuid,
            "voice_presentation": presentation,
            "language": "ja",
            "default_style": default_style["id"],
            "style_id": default_style["style_id"],
            "styles": styles,
            "capabilities": {
                "speed": {"minimum": 0.5, "maximum": 2.0, "default": 1.0},
                "pitch_scale": {"minimum": -0.15, "maximum": 0.15, "default": 0.0},
                "intonation_scale": {"minimum": 0.0, "maximum": 2.0, "default": 1.0},
            },
            "credit": credit,
        }
    if DEFAULT_VOICE not in rebuilt:
        raise RuntimeError(f"unsupported VOICEVOX_DEFAULT_VOICE: {DEFAULT_VOICE}")
    voice_catalog = rebuilt
    style_owners = owners


def resolve_style(voice: str, requested_style: str | int | None) -> tuple[int, str]:
    resolved_voice = voice
    if resolved_voice not in voice_catalog:
        by_display_name = [
            voice_id
            for voice_id, metadata in voice_catalog.items()
            if metadata["display_name"] == voice
        ]
        if len(by_display_name) == 1:
            resolved_voice = by_display_name[0]
    if resolved_voice not in voice_catalog:
        try:
            legacy_style_id = int(voice)
        except ValueError:
            legacy_style_id = -1
        legacy_owner = style_owners.get(legacy_style_id)
        if legacy_owner is not None and requested_style is None:
            return legacy_style_id, legacy_owner
        available = ", ".join(voice_catalog)
        raise HTTPException(status_code=400, detail=f"Unknown voice. Available voices: {available}")

    metadata = voice_catalog[resolved_voice]
    styles = metadata["styles"]
    if not isinstance(styles, list):
        raise RuntimeError("VOICEVOX voice catalog is inconsistent")
    selection = requested_style if requested_style is not None else metadata["default_style"]
    try:
        numeric_selection = int(selection)
    except (TypeError, ValueError):
        numeric_selection = None
    for style in styles:
        if (
            style["id"] == selection
            or style["display_name"] == selection
            or (numeric_selection is not None and style["style_id"] == numeric_selection)
        ):
            return int(style["style_id"]), resolved_voice
    raise HTTPException(
        status_code=400,
        detail=f"Invalid style for voice {resolved_voice}",
    )


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
    global synthesizer, voice_catalog, style_owners
    runtime = Onnxruntime.load_once(filename=str(ONNXRUNTIME_PATH))
    instance = Synthesizer(
        runtime,
        OpenJtalk(DICT_PATH),
        acceleration_mode="CPU",
        cpu_num_threads=CPU_THREADS,
    )
    for vvm_path in VVM_PATHS:
        with VoiceModelFile.open(vvm_path) as voice_model:
            instance.load_voice_model(voice_model)
    rebuild_voice_catalog(instance)
    synthesizer = instance
    yield
    synthesizer = None
    voice_catalog = {}
    style_owners = {}


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
        "voices": {
            voice_id: metadata["style_id"]
            for voice_id, metadata in voice_catalog.items()
        },
        "vvm_files": [path.name for path in VVM_PATHS],
        "missing_optional_vvm_files": MISSING_OPTIONAL_VVMS,
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
    if synthesizer is None:
        raise HTTPException(status_code=503, detail="Synthesizer is starting")
    return {
        "default_voice": DEFAULT_VOICE,
        "voices": list(voice_catalog.values()),
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
    style_id, voice_name = resolve_style(request.voice, request.style)
    if not synthesis_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="VOICEVOX provider is busy",
            headers={"Retry-After": "1"},
        )
    try:
        query = synthesizer.create_audio_query(request.input, style_id)
        query.speed_scale = request.speed
        query.pitch_scale = request.pitch_scale
        query.intonation_scale = request.intonation_scale
        wav_bytes = synthesizer.synthesis(query, style_id)
    finally:
        synthesis_lock.release()
    credit = voice_catalog[voice_name]["credit"]
    if not isinstance(credit, str):
        raise RuntimeError("VOICEVOX voice credit is invalid")
    credit_header = encode_credit_header(credit)
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
