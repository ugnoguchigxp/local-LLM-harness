import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { parseComputeRequest } from "@larm/core";
import { LinuxCpuComputeExecutor } from "./executor";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compute-process-"));
  mkdirSync(join(root, "bin")); writeFileSync(join(root, "bin/python3"), ""); writeFileSync(join(root, "pyvenv.cfg"), "");
  let unreferenced = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    unref: () => { unreferenced = true; } });
  const executor = new LinuxCpuComputeExecutor({ runtimeRoot: root, runner: join(root, "runner.py"), requirements: join(root, "requirements.txt"),
    launch: () => child as unknown as ChildProcessWithoutNullStreams });
  return { child, executor, isUnreferenced: () => unreferenced, cleanup: () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); rmSync(root, { recursive: true, force: true }); } };
}

test("compute does not confirm cancellation when a killed process never closes", async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const task = f.executor.execute(parseComputeRequest({ code: "result=2" }), {
      signal: abort.signal, progress: () => {}, stage: () => abort.abort(),
    });
    f.child.stdout.write('{"kind":"ready"}\n');
    await expect(task).rejects.toMatchObject({ code: "unavailable", executionUncertain: true });
    expect(f.isUnreferenced()).toBe(true);
    f.child.emit("close", 0); // A late close must not settle the operation again.
  } finally { f.cleanup(); }
}, 5000);

test("compute ignores additional frames after cancellation and handles pipe failures", async () => {
  const f = fixture(); const abort = new AbortController(); let progress = 0;
  try {
    const task = f.executor.execute(parseComputeRequest({ code: "result=2" }), {
      signal: abort.signal, progress: () => { progress++; }, stage: () => abort.abort(),
    });
    f.child.stdout.write('{"kind":"ready"}\n{"kind":"progress","message":"late"}\n'); f.child.emit("close", 0);
    await expect(task).rejects.toMatchObject({ code: "cancelled" }); expect(progress).toBe(0);
  } finally { f.cleanup(); }
  const second = fixture();
  try {
    const task = second.executor.execute(parseComputeRequest({ code: "result=2" }), { signal: new AbortController().signal, progress: () => {} });
    second.child.stdout.emit("error", new Error("do not log this message")); second.child.emit("close", 1);
    await expect(task).rejects.toMatchObject({ code: "unavailable", message: "CPU sandbox communication failed" });
  } finally { second.cleanup(); }
});
