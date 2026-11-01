"""Single-worker Audio8 provider. Model code and voice assets stay outside the repo."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import wave

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from scipy.signal import resample_poly

MODEL = "audio8-tts-realistic-0.6b"
REVISION = "1e857568bfd4f02931aca3988ee773a44d2d26d3"
SAMPLE_RATE = 24000
NATIVE_RATE = 44100
MAX_INPUT = 150
MAX_FRAMES = 650
MAX_BODY = 65536
logger = logging.getLogger(__name__)
CONTROLS = {
    "speed": {"minimum": 1, "maximum": 1, "default": 1},
    "pitch_scale": {"minimum": 0, "maximum": 0, "default": 0},
    "intonation_scale": {"minimum": 1, "maximum": 1, "default": 1},
}
DEFAULT_VOICE_MANIFEST = "/srv/ai/models/Edge0/audio8-ja-voices-v2/manifest.json"
APPROVED_OUTPUT_PRESET = "butler-chest-speed143-v1"
OUTPUT_PRESETS = {
    APPROVED_OUTPUT_PRESET: {
        "tempo": 1.43,
        "chest_eq": [
            {"frequency_hz": 160, "q": 0.8, "gain_db": 4.5},
            {"frequency_hz": 300, "q": 1, "gain_db": 2.5},
        ],
        "rms": 0.08,
        "peak": 0.95,
    },
}


class GenerationStopped(Exception):
    pass


class InvalidGeneration(Exception):
    pass


def fail(code: str, message: str, status: int = 400, param: str | None = None):
    raise HTTPException(status, {"code": code, "message": message, "param": param})


def checked_file(root: Path, name: str, size: int, digest: str) -> Path:
    if Path(name).name != name or name in (".", ".."):
        raise RuntimeError("asset must be a plain filename")
    path = root / name
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise RuntimeError(f"Missing or wrong-sized Audio8 asset: {name}")
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        raise RuntimeError(f"Audio8 asset checksum mismatch: {name}")
    return path


def read_voices(manifest_path: Path, expected_manifest: dict | None = None) -> dict:
    if manifest_path.is_symlink():
        raise RuntimeError("voice manifest must not be a symlink")
    manifest = json.loads(manifest_path.read_text())
    if expected_manifest is not None and manifest != expected_manifest:
        raise RuntimeError("voice manifest differs from the pinned provider configuration")
    if manifest["model_revision"] != REVISION:
        raise RuntimeError("voice codes were prepared for a different model revision")
    voices = {}
    for v in manifest["voices"]:
        if not v["id"] or v["id"] in voices or not v["reference_text"].strip():
            raise RuntimeError("invalid or duplicate voice")
        preset_id = v.get("output_preset")
        if preset_id is not None and (not isinstance(preset_id, str) or preset_id not in OUTPUT_PRESETS):
            raise RuntimeError("unknown voice output preset")
        path = checked_file(manifest_path.parent, v["file"], v["bytes"], v["sha256"])
        codes = np.load(path, allow_pickle=False)
        if codes.ndim != 2 or codes.shape[0] != 10 or not 0 < codes.shape[1] <= 320:
            raise RuntimeError("invalid reference code shape")
        if codes.dtype.kind not in "iu" or codes.min() < 0 or codes.max() >= 4096:
            raise RuntimeError("invalid reference code values")
        voices[v["id"]] = {**v, "codes": codes}
    if manifest["default_voice"] not in voices:
        raise RuntimeError("default voice must exist")
    return {"default_voice": manifest["default_voice"], "voices": voices}


def load_model(root: Path):
    # Review and checksum custom code before Transformers imports it.
    manifest = json.loads(Path(__file__).with_name("model-manifest.json").read_text())
    if manifest["revision"] != REVISION:
        raise RuntimeError("model revision mismatch")
    for asset in manifest["files"]:
        checked_file(root, asset["file"], asset["bytes"], asset["sha256"])
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import torch
    from transformers import AutoModel, AutoProcessor

    if not torch.cuda.is_available():
        raise RuntimeError("The validated Audio8 runtime requires a ROCm/CUDA GPU")
    torch._C._jit_set_texpr_fuser_enabled(False)
    torch._C._jit_override_can_fuse_on_gpu(False)
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    processor = AutoProcessor.from_pretrained(root, trust_remote_code=True, local_files_only=True)
    model = AutoModel.from_pretrained(root, trust_remote_code=True, local_files_only=True,
                                     dtype=torch.bfloat16).eval().to("cuda")
    model.load_codec(device="cuda")
    torch.cuda.synchronize()
    return torch, processor, model


class Audio8Engine:
    def __init__(self):
        root = Path(os.getenv("AUDIO8_MODEL_ROOT", "/srv/ai/models/Edge0/Audio8-TTS-Realistic-0.6b"))
        voice_path = Path(os.getenv("AUDIO8_VOICE_MANIFEST", DEFAULT_VOICE_MANIFEST))
        expected = json.loads(Path(__file__).with_name("voice-manifest.json").read_text())
        bank = read_voices(voice_path, expected)
        self.default_voice = bank["default_voice"]
        self.voices = bank["voices"]
        if any(v.get("output_preset") for v in self.voices.values()) and shutil.which("ffmpeg") is None:
            raise RuntimeError("The selected Audio8 voice requires FFmpeg")
        self.torch, self.processor, self.model = load_model(root)

    def generate(self, text: str, voice: str, cancel: threading.Event, deadline: float):
        from transformers import StoppingCriteria, StoppingCriteriaList
        torch = self.torch

        class Stop(StoppingCriteria):
            def __call__(self, *_args, **_kwargs):
                return cancel.is_set() or time.monotonic() >= deadline

        reference = self.voices[voice]
        torch.manual_seed(42)
        torch.cuda.manual_seed_all(42)
        inputs = self.processor(text=[text], reference_text=[reference["reference_text"]],
                                reference_codes=[reference["codes"]], return_tensors="pt")
        inputs = {key: value.to("cuda") for key, value in inputs.items()}
        try:
            with torch.inference_mode():
                output = self.model.generate(**inputs, max_new_tokens=MAX_FRAMES, temperature=0.8,
                                            top_p=0.95, top_k=50, do_sample=True,
                                            return_dict_in_generate=True,
                                            stopping_criteria=StoppingCriteriaList([Stop()]))
                if cancel.is_set() or time.monotonic() >= deadline:
                    raise GenerationStopped()
                if not bool(output.finished[0]):
                    raise InvalidGeneration("EOS was not reached")
                wavs, lengths = self.model.decode_audio(output.codes)
                audio = wavs[0, :int(lengths[0])].float().cpu().numpy()
                if cancel.is_set() or time.monotonic() >= deadline:
                    raise GenerationStopped()
                return audio, NATIVE_RATE
        finally:
            # Cancellation cannot release the slot while a codec kernel is still running.
            torch.cuda.synchronize()


def check_processing_deadline(cancel, deadline):
    if (cancel is not None and cancel.is_set()) or (deadline is not None and time.monotonic() >= deadline):
        raise GenerationStopped()


def filter_pcm(pcm: bytes, expression: str, cancel, deadline):
    check_processing_deadline(cancel, deadline)
    timeout = min(10.0, deadline - time.monotonic()) if deadline is not None else 10.0
    if timeout <= 0:
        raise GenerationStopped()
    try:
        result = subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
            "-filter_threads", "1", "-af", expression, "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1",
        ], input=pcm, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        check_processing_deadline(cancel, deadline)
        raise InvalidGeneration("voice output processing timed out") from None
    except OSError:
        raise InvalidGeneration("voice output processor is unavailable") from None
    check_processing_deadline(cancel, deadline)
    if result.returncode or not result.stdout or len(result.stdout) % 4:
        raise InvalidGeneration("voice output processing failed")
    data = np.frombuffer(result.stdout, dtype="<f4")
    if data.size > SAMPLE_RATE * 31 or not np.isfinite(data).all():
        raise InvalidGeneration("invalid processed audio")
    return data.copy()


def normalized_pcm(data, preset) -> bytes:
    import soundfile as sf

    peak = float(np.abs(data).max())
    rms = float(np.sqrt(np.mean(data * data)))
    if not math.isfinite(rms) or peak < 1e-6 or rms < 1e-6:
        raise InvalidGeneration("silent or invalid processed audio")
    data *= min(preset["rms"] / rms, preset["peak"] / peak)
    buffer = io.BytesIO()
    # Match the PCM16 quantization used in the approved audition, after each stage.
    sf.write(buffer, data, SAMPLE_RATE, format="RAW", subtype="PCM_16", endian="LITTLE")
    return buffer.getvalue()


def apply_output_preset(pcm: bytes, preset_id: str, cancel=None, deadline=None) -> bytes:
    preset = OUTPUT_PRESETS.get(preset_id)
    if preset is None:
        raise InvalidGeneration("unknown voice output preset")
    # The accepted audition normalized tempo output before applying the chest EQ.
    data = filter_pcm(pcm, f'atempo={preset["tempo"]}', cancel, deadline)
    pcm = normalized_pcm(data, preset)
    filters = ",".join(
        f'equalizer=frequency={eq["frequency_hz"]}:width_type=q:width={eq["q"]}:gain={eq["gain_db"]}'
        for eq in preset["chest_eq"]
    )
    data = filter_pcm(pcm, filters, cancel, deadline)
    return normalized_pcm(data, preset)


def encode_audio(audio, rate: int, response_format: str, *, output_preset=None,
                 cancel=None, deadline=None) -> tuple[bytes, str]:
    data = np.asarray(audio)
    if data.ndim != 1 or not data.size or data.size > NATIVE_RATE * 31 or rate != NATIVE_RATE:
        raise InvalidGeneration("invalid audio shape, rate, or duration")
    if not np.isfinite(data).all():
        raise InvalidGeneration("non-finite audio")
    # 44100 -> 24000, anti-alias filtering; do not relabel the native samples.
    data = resample_poly(data.astype(np.float32), 80, 147)
    if not np.isfinite(data).all() or not data.size:
        raise InvalidGeneration("invalid resampled audio")
    peak = float(np.abs(data).max())
    if peak < 1e-6:
        raise InvalidGeneration("silent audio")
    if peak > 0.999:
        data *= 0.999 / peak
    pcm = np.rint(np.clip(data, -1, 1) * 32767).astype("<i2").tobytes()
    if output_preset is not None:
        pcm = apply_output_preset(pcm, output_preset, cancel, deadline)
    if response_format == "pcm":
        return pcm, "audio/pcm;rate=24000;channels=1;format=s16le"
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buffer.getvalue(), "audio/wav"


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    model: str = MODEL
    input: str = Field(min_length=1, max_length=4096)
    voice: str | None = None
    style: str | int | None = None
    speed: float = Field(default=1.0, strict=True)
    pitch_scale: float = Field(default=0.0, strict=True)
    intonation_scale: float = Field(default=1.0, strict=True)
    response_format: str = "wav"
    stream: bool = False
    language: str | None = "ja"
    instruct: str | None = None


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/v1/audio/speech":
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > MAX_BODY:
                return await JSONResponse({"error": {"code": "request_body_too_large",
                    "message": "request body exceeds 64 KiB"}}, status_code=413)(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        return await self.app(scope, bounded_receive, send)


def create_app(engine_factory=Audio8Engine, deadline_seconds: float = 90.0):
    if not math.isfinite(deadline_seconds) or not 0 < deadline_seconds <= 300:
        raise ValueError("deadline must be finite and between 0 and 300 seconds")
    lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app):
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio8")
        app.state.executor = executor
        try:
            app.state.engine = await asyncio.get_running_loop().run_in_executor(executor, engine_factory)
            yield
        finally:
            # Process shutdown drains the only worker before releasing its GPU context.
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
            app.state.engine = None

    app = FastAPI(title="Audio8 Japanese speech provider", lifespan=lifespan)
    app.state.engine = None
    app.add_middleware(BodyLimit)

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        detail = error.detail if isinstance(error.detail, dict) else {"code": "invalid_request", "message": str(error.detail)}
        return JSONResponse({"error": detail}, status_code=error.status_code, headers=error.headers)

    def engine():
        if app.state.engine is None:
            raise HTTPException(503, {"code": "speech_provider_unavailable", "message": "Audio8 is starting"},
                                headers={"Retry-After": "1"})
        return app.state.engine

    @app.get("/health")
    def health(fail_on_no_slot: bool = False):
        ready = app.state.engine is not None
        busy = lock.locked()
        body = {"status": "healthy" if ready else "starting", "ready": ready, "busy": busy,
                "model": MODEL, "revision": REVISION, "sample_rate": SAMPLE_RATE,
                "native_sample_rate": NATIVE_RATE, "native_streaming": False, "max_input_characters": MAX_INPUT}
        if ready:
            instance = app.state.engine
            selected = instance.voices[instance.default_voice]
            preset_id = selected.get("output_preset")
            body.update(default_voice=instance.default_voice, default_output_preset=preset_id,
                        default_output_processing=OUTPUT_PRESETS.get(preset_id))
        if not ready or (fail_on_no_slot and busy):
            return JSONResponse(body, status_code=503, headers={"Retry-After": "1"})
        return body

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": MODEL, "object": "model"}]}

    @app.get("/v1/audio/voices")
    def voices(model: str = MODEL):
        if model != MODEL:
            fail("model_not_found", "unknown speech model", 404, "model")
        instance = engine()
        return {"default_voice": instance.default_voice, "voices": [{
            "id": v["id"], "name": v["id"], "display_name": v["display_name"],
            "language": "ja", "voice_presentation": "unspecified", "styles": [], "capabilities": CONTROLS,
        } for v in instance.voices.values()]}

    @app.post("/v1/audio/speech")
    async def speech(body: SpeechRequest, request: Request):
        if body.model != MODEL:
            fail("model_not_found", "unknown speech model", 404, "model")
        instance = engine()
        text = body.input.strip()
        if len(body.input) > MAX_INPUT:
            fail("invalid_request", "Audio8 accepts at most 150 characters per request", param="input")
        if not any(c.isalnum() for c in text):
            fail("speech_text_unprocessable", "input contains no speakable text", 422, "input")
        voice = body.voice if body.voice is not None else instance.default_voice
        if voice not in instance.voices:
            fail("invalid_request", "unknown voice for this model", param="voice")
        if body.response_format not in ("wav", "pcm"):
            fail("unsupported_parameter", "supported formats are wav and pcm", param="response_format")
        for name, expected in (("speed", 1), ("pitch_scale", 0), ("intonation_scale", 1)):
            if getattr(body, name) != expected:
                fail("unsupported_parameter", f"Audio8 currently supports only {name}={expected}", param=name)
        for name, supported in (("style", body.style is None), ("stream", not body.stream),
                                ("language", body.language in (None, "ja", "japanese", "Japanese")),
                                ("instruct", not body.instruct)):
            if not supported:
                fail("unsupported_parameter", f"Audio8 does not support the requested {name}", param=name)
        if not lock.acquire(blocking=False):
            raise HTTPException(429, {"code": "provider_busy", "message": "Audio8 provider is busy"},
                                headers={"Retry-After": "1"})
        cancel = threading.Event()
        deadline = time.monotonic() + deadline_seconds

        def work():
            try:
                audio, rate = instance.generate(text, voice, cancel, deadline)
                if cancel.is_set() or time.monotonic() >= deadline:
                    raise GenerationStopped()
                encoded = encode_audio(audio, rate, body.response_format,
                                       output_preset=instance.voices[voice].get("output_preset"),
                                       cancel=cancel, deadline=deadline)
                if cancel.is_set() or time.monotonic() >= deadline:
                    raise GenerationStopped()
                return encoded
            finally:
                lock.release()

        try:
            future = asyncio.get_running_loop().run_in_executor(app.state.executor, work)
        except BaseException:
            lock.release()
            raise
        # Retrieve late exceptions even when the caller has disconnected or timed out.
        future.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        try:
            while not future.done():
                if await request.is_disconnected():
                    cancel.set()
                    fail("request_cancelled", "client disconnected", 400)
                if time.monotonic() >= deadline:
                    cancel.set()
                    fail("speech_timeout", "speech generation exceeded its deadline", 504)
                await asyncio.wait({future}, timeout=0.05)
            try:
                payload, media_type = future.result()
            except GenerationStopped:
                fail("speech_timeout", "speech generation stopped at its deadline", 504)
            except Exception:
                # Do not expose private input or exception chains to logs or clients.
                logger.warning("Audio8 generation failed; input_length=%d", len(text))
                fail("speech_generation_failed", "Audio8 could not produce complete audio", 502)
            return Response(payload, media_type=media_type, headers={
                "X-Audio-Sample-Rate": str(SAMPLE_RATE), "X-Audio-Sample-Format": "s16le",
            })
        finally:
            cancel.set()

    return app


app = create_app()
