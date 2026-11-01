import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
const python = process.env.AUDIO8_TEST_PYTHON ?? "/srv/ai/apps/audio8-tts-runtime/.venv/bin/python";
test.skipIf(!existsSync(python))("Audio8 API validates formats, cancellation, reference integrity and readiness without a GPU", async () => {
  const child = Bun.spawn([python, "-B", "-m", "unittest", "-v", "test_audio8_api"], {
    cwd: import.meta.dir, env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1", OPENBLAS_NUM_THREADS: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stdout + stderr).toBe(0);
}, 20_000);
