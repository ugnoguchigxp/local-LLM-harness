import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { audioVoiceListSchema } from "../../packages/core/src/index";

const runtimeRoot = "/srv/ai/apps/voicevox-core-0.17.0/runtime";
const python = "/srv/ai/apps/voicevox-core-0.17.0/.venv/bin/python";
const adapter = resolve(import.meta.dir, "voicevox_api.py");
const available = existsSync(python) && existsSync(join(runtimeRoot, "models/vvms/0.vvm"));

async function runPython(source: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn([python, "-c", source, adapter], {
    env: {
      ...Bun.env,
      PYTHONDONTWRITEBYTECODE: "1",
      VOICEVOX_RUNTIME_ROOT: runtimeRoot,
      VOICEVOX_THREADS: "1",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test.skipIf(!available)("VOICEVOX adapter builds a valid catalog and resolves legacy and named styles", async () => {
  const result = await runPython(`
import importlib.util, json, sys
from types import SimpleNamespace
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("larm_voicevox_api_test", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
runtime = module.Onnxruntime.load_once(filename=str(module.ONNXRUNTIME_PATH))
instance = module.Synthesizer(
    runtime,
    module.OpenJtalk(module.DICT_PATH),
    acceleration_mode="CPU",
    cpu_num_threads=1,
)
for vvm_path in module.VVM_PATHS:
    with module.VoiceModelFile.open(vvm_path) as voice_model:
        instance.load_voice_model(voice_model)
module.rebuild_voice_catalog(instance)
module.synthesizer = instance
assert module.resolve_style("Shikoku_Metan", "sweet") == (0, "Shikoku_Metan")
assert module.resolve_style("3", None) == (3, "Zundamon")
query = instance.create_audio_query("確認です。", 0)
query.speed_scale = 1.1
query.pitch_scale = 0.03
query.intonation_scale = 1.2
catalog = module.voices()
speaker_uuid = "00000000-0000-0000-0000-000000000001"
module.DEFAULT_VOICE = speaker_uuid
module.rebuild_voice_catalog(SimpleNamespace(metas=lambda: [
    SimpleNamespace(
        name="テスト話者",
        speaker_uuid=speaker_uuid,
        styles=[SimpleNamespace(name="ささやき", id=22, type="talk")],
    ),
    SimpleNamespace(
        name="テスト話者",
        speaker_uuid=speaker_uuid,
        styles=[SimpleNamespace(name="ノーマル", id=23, type="talk")],
    ),
]))
assert module.voice_catalog[speaker_uuid]["default_style"] == "normal"
module.DEFAULT_VOICE = "Kurono_Takehiro"
try:
    module.rebuild_voice_catalog(SimpleNamespace(metas=lambda: [
        SimpleNamespace(
            name="玄野武宏",
            speaker_uuid="00000000-0000-0000-0000-000000000002",
            styles=[SimpleNamespace(name="ノーマル", id=24, type="talk")],
        ),
        SimpleNamespace(
            name="玄野武宏",
            speaker_uuid="00000000-0000-0000-0000-000000000003",
            styles=[SimpleNamespace(name="ノーマル", id=25, type="talk")],
        ),
    ]))
    raise AssertionError("duplicate voice id was accepted")
except RuntimeError as error:
    assert "multiple speakers" in str(error)
print(json.dumps({
    "catalog": catalog,
    "query": [query.speed_scale, query.pitch_scale, query.intonation_scale],
}, ensure_ascii=False))
`);
  expect(result.exitCode, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as { catalog: unknown; query: number[] };
  const catalog = audioVoiceListSchema.parse(output.catalog);
  expect(catalog.voices).toHaveLength(4);
  expect(catalog.voices.reduce((total, voice) => total + voice.styles.length, 0)).toBe(10);
  expect(output.query).toEqual([1.1, 0.03, 1.2]);
});

test.skipIf(!available)("VOICEVOX adapter rejects symlinked VVM files before model loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-voicevox-symlink-"));
  try {
    const vvmDirectory = join(root, "models/vvms");
    await Bun.write(join(root, "placeholder"), "not-a-vvm");
    await mkdir(vvmDirectory, { recursive: true });
    await symlink(join(root, "placeholder"), join(vvmDirectory, "0.vvm"));
    const result = await runPython("exec(open(__import__('sys').argv[1]).read())", {
      VOICEVOX_RUNTIME_ROOT: root,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must not be a symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!available)("VOICEVOX speech classifies unreadable text and releases its slot for the next sentence", async () => {
  const result = await runPython(`
import asyncio, importlib.util, io, json, logging, sys, wave
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("larm_voicevox_errors_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

async def request(path, body=None):
    messages = []
    encoded = json.dumps(body).encode() if body is not None else b""
    async def receive():
        return {"type": "http.request", "body": encoded, "more_body": False}
    async def send(message):
        messages.append(message)
    await module.app({
        "type": "http", "http_version": "1.1", "method": "POST" if body is not None else "GET",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(b"content-type", b"application/json")],
        "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 8084), "root_path": "",
    }, receive, send)
    start = next(m for m in messages if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), payload

async def main():
    for path, body in [("/health", None), ("/v1/audio/voices", None), ("/v1/audio/speech", {"input": "確認です。"})]:
        status, headers, payload = await request(path, body)
        assert status == 503 and headers[b"retry-after"] == b"1"
        if path != "/health":
            assert json.loads(payload)["error"]["code"] == "speech_provider_unavailable"
    async with module.lifespan(module.app):
        for text in ["。", "   ", "…", "！？"]:
            status, headers, payload = await request("/v1/audio/speech", {"input": text})
            assert status == 422, (text, status)
            assert json.loads(payload)["error"] == {
                "code": "speech_text_unprocessable",
                "message": "VOICEVOX could not analyze input text", "param": "input",
            }
            assert b"retry-after" not in headers
            assert not module.synthesis_lock.locked()
        status, headers, payload = await request("/v1/audio/speech", {"input": "確認です。"})
        assert status == 200 and headers[b"content-type"] == b"audio/wav"
        with wave.open(io.BytesIO(payload)) as audio:
            assert audio.getnframes() > 0
        status, headers, payload = await request("/v1/audio/speech", {"input": "確認です。", "response_format": "pcm"})
        assert status == 200 and len(payload) > 0
        assert headers[b"content-type"].startswith(b"audio/pcm;")
        module.synthesis_lock.acquire()
        try:
            status, headers, _ = await request("/v1/audio/speech", {"input": "確認です。"})
            assert status == 429 and headers[b"retry-after"] == b"1"
            response = module.health(fail_on_no_slot=True)
            assert response.status_code == 503 and response.headers["retry-after"] == "1"
        finally:
            module.synthesis_lock.release()
        logs = io.StringIO()
        handler = logging.StreamHandler(logs)
        module.logger.addHandler(handler)
        def failed_analysis(*_):
            raise module.AnalyzeTextError("private-text-marker")
        real_instance = module.synthesizer
        module.synthesizer = SimpleNamespace(create_audio_query=failed_analysis)
        try:
            status, _, payload = await request("/v1/audio/speech", {"input": "private-text-marker"})
            assert status == 422
            assert "private-text-marker" not in logs.getvalue() and b"private-text-marker" not in payload
            assert "input_length=19" in logs.getvalue()
            def failed_synthesis(*_):
                raise RuntimeError("unexpected inference failure")
            module.synthesizer = SimpleNamespace(create_audio_query=real_instance.create_audio_query, synthesis=failed_synthesis)
            try:
                module.speech(module.SpeechRequest(input="確認です。"))
                raise AssertionError("unexpected inference error was hidden")
            except RuntimeError as error:
                assert str(error) == "unexpected inference failure"
            assert not module.synthesis_lock.locked()
        finally:
            module.logger.removeHandler(handler)
            module.synthesizer = real_instance
    print("speech error classification and recovery passed")

asyncio.run(main())
`);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("speech error classification and recovery passed");
}, 15_000);
