import { expect, test } from "bun:test";
import { join } from "node:path";

test("VOICEVOX release application handles authentication, interruption, rollback, and concurrent operations", async () => {
  const child = Bun.spawn(["python3", "-B", join(import.meta.dir, "apply-voicevox-release.test.py")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(status, stdout + stderr).toBe(0);
}, 15_000);
