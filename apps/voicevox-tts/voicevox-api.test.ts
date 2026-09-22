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
