import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { COMPUTE_LIMITS, ComputeError, computeEnvironmentSchema, type ComputeExecutor, type ComputeJob } from "@larm/core";
import { ComputeManager } from "./manager";

function environment(revision = "test-cpu") {
  return computeEnvironmentSchema.parse({ protocol: "larm.compute.v1", python: "test", packages: [], accelerators: [],
    limits: COMPUTE_LIMITS, environmentRevision: revision,
    sandbox: { kind: "bubblewrap", network: false, gpu: false, subprocesses: false, userThreads: false, memoryAccounting: "address_space" } });
}
const result = { value: 2, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, artifacts: [] };
const fixtures: Array<{ manager: ComputeManager; root: string }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.manager.close(); rmSync(fixture.root, { recursive: true, force: true }); } });
async function fixture(executor: ComputeExecutor = { environment: async () => environment(), execute: async () => result }, now?: () => number, maintenanceIntervalMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "larm-compute-"));
  const manager = new ComputeManager({ root, executor, now, maintenanceIntervalMs }); fixtures.push({ manager, root }); await manager.initialize();
  return { manager, root };
}
async function terminal(manager: ComputeManager, id: string, principal = "a"): Promise<ComputeJob> {
  for (let count = 0; count < 800; count++) {
    const job = manager.get(id, principal);
    if (job.status !== "queued" && job.status !== "running") return job;
    await Bun.sleep(2);
  }
  throw new Error("test job did not finish");
}

test("compute idempotency is durable, canonical, and scoped; terminal requests are scrubbed", async () => {
  const { manager, root } = await fixture();
  const receipt = manager.submit({ code: "result = 1+1", inputs: { b: 2, a: 1 } }, "a", "once");
  expect(manager.submit({ inputs: { a: 1, b: 2 }, timeoutSec: 60, accelerator: "auto", code: "result = 1+1" }, "a", "once")).toEqual(receipt);
  expect(() => manager.submit({ code: "result = 3" }, "a", "once")).toThrow(ComputeError);
  expect(() => manager.get(receipt.jobId, "b")).toThrow("not found");
  expect((await terminal(manager, receipt.jobId)).result?.value).toBe(2);
  await manager.close(); fixtures.pop();
  const db = new Database(join(root, "compute.sqlite"), { readonly: true });
  expect((db.query("SELECT request FROM jobs WHERE id=?").get(receipt.jobId) as { request: null }).request).toBeNull(); db.close();
  const restarted = new ComputeManager({ root, executor: { environment: async () => environment(), execute: async () => result } });
  fixtures.push({ manager: restarted, root }); await restarted.initialize();
  expect(restarted.submit({ code: "result = 1+1", inputs: { b: 2, a: 1 } }, "a", "once")).toEqual(receipt);
  expect(restarted.get(receipt.jobId, "a").status).toBe("completed");
});

test("compute cancellation suppresses late results and serializes jobs", async () => {
  let started = 0;
  const { manager } = await fixture({ environment: async () => environment(), execute: async (_request, context) => {
    started++; context.stage?.("running"); context.progress({ message: "working", ratio: 0.5 });
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result; // Deliberately races cancellation with a successful backend result.
  } });
  const first = manager.submit({ code: "result=1" }, "a", "one");
  const second = manager.submit({ code: "result=2" }, "a", "two");
  await Bun.sleep(5);
  expect(started).toBe(1);
  expect(manager.get(first.jobId, "a").progress?.ratio).toBe(0.5);
  expect((await manager.cancel(second.jobId, "a")).status).toBe("cancelled");
  const cancelled = await manager.cancel(first.jobId, "a");
  expect(cancelled.status).toBe("cancelled"); expect(cancelled.result).toBeUndefined(); expect(cancelled.progress).toBeUndefined();
  expect(started).toBe(1);
});

test("compute artifact publication, cancel-after-completion, deletion and replay tombstones", async () => {
  const { manager } = await fixture({ environment: async () => environment(), execute: async () => ({ ...result,
    artifacts: [{ name: "table.json", mime: "application/json", data: Buffer.from("[1,2]") }] }) });
  const { jobId } = manager.submit({ code: "result=2" }, "a", "artifact");
  const job = await terminal(manager, jobId);
  const id = job.result!.artifacts[0]!.id;
  expect(Buffer.from(manager.artifact(jobId, id, "a").data).toString()).toBe("[1,2]");
  expect((await manager.cancel(jobId, "a")).status).toBe("completed");
  expect(await manager.delete(jobId, "a")).toBeUndefined();
  expect(() => manager.artifact(jobId, id, "a")).toThrow("deleted or expired");
  expect(() => manager.submit({ code: "result=2" }, "a", "artifact")).toThrow("deleted or expired");
});

test("compute expires results, preserves bounded receipts, then allows new intentional work", async () => {
  let now = Date.now();
  const { manager } = await fixture(undefined, () => now);
  const first = manager.submit({ code: "result=2" }, "a", "ttl"); await terminal(manager, first.jobId);
  now += (COMPUTE_LIMITS.retentionSec + 1) * 1000;
  expect(() => manager.get(first.jobId, "a")).toThrow("deleted or expired");
  expect(() => manager.submit({ code: "result=3" }, "a", "ttl")).toThrow("different request");
  now += COMPUTE_LIMITS.idempotencyRetentionSec * 1000;
  expect(manager.submit({ code: "result=2" }, "a", "ttl").jobId).not.toBe(first.jobId);
});

test("compute detects changed execution environments and refuses GPU or oversized inputs", async () => {
  let probes = 0;
  const { manager } = await fixture({ environment: async () => environment(String(probes++)), execute: async () => result });
  expect(() => manager.submit({ code: "result=2", accelerator: "gpu" }, "a", "gpu")).toThrow("CPU only");
  expect(() => manager.submit({ code: "x".repeat(COMPUTE_LIMITS.maxCodeBytes + 1) }, "a", "big")).toThrow("byte limits");
  const { jobId } = manager.submit({ code: "result=2" }, "a", "change");
  expect((await terminal(manager, jobId)).error?.code).toBe("unavailable");
});

test("compute bounds result storage reservations and queue wait", async () => {
  let now = Date.now();
  const { manager } = await fixture({ environment: async () => environment(), execute: async (_request, context) => {
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); return result;
  } }, () => now);
  const receipts = Array.from({ length: 4 }, (_, index) => manager.submit({ code: "result=2" }, "a", String(index)));
  expect(() => manager.submit({ code: "result=2" }, "a", "full")).toThrow("full");
  await Bun.sleep(5); now += (COMPUTE_LIMITS.maxQueueWaitSec + 1) * 1000;
  expect(manager.get(receipts[1]!.jobId, "a").error?.code).toBe("queue_timeout");
});

test("compute deadline includes execution environment probing", async () => {
  const { manager } = await fixture({ environment: async signal => {
    if (!signal) return environment();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return environment();
  }, execute: async () => { throw new Error("execution must not start after deadline"); } });
  const receipt = manager.submit({ code: "result=2", timeoutSec: 1 }, "a", "deadline");
  expect((await terminal(manager, receipt.jobId)).error?.code).toBe("timeout");
});

test("compute resumes queued jobs after restart and never replays interrupted execution", async () => {
  const { manager, root } = await fixture({ environment: async () => environment(), execute: async (_request, context) => {
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); return result;
  } });
  const first = manager.submit({ code: "result=1" }, "a", "interrupted");
  const second = manager.submit({ code: "result=2" }, "a", "queued");
  await Bun.sleep(5); await manager.close(); fixtures.pop();
  let executions = 0;
  const restarted = new ComputeManager({ root, executor: { environment: async () => environment(), execute: async () => { executions++; return result; } } });
  fixtures.push({ manager: restarted, root }); await restarted.initialize();
  expect(restarted.get(first.jobId, "a").error?.code).toBe("unavailable");
  expect((await terminal(restarted, second.jobId)).result?.value).toBe(2);
  expect(executions).toBe(1);
});

test("compute isolates storage failures in maintenance and scheduling", async () => {
  const { manager } = await fixture(undefined, undefined, 5);
  manager["store"].db.exec("DROP TABLE jobs");
  manager["schedule"]();
  await Bun.sleep(20);
  expect(manager.available).toBe(false);
  expect(() => manager.environment()).toThrow("not ready");
  expect(() => manager.get("missing", "a")).toThrow("Compute storage is unavailable");
});

test("compute never publishes partial artifacts after a storage transaction fails", async () => {
  const { manager } = await fixture({ environment: async () => environment(), execute: async () => ({ ...result,
    artifacts: [{ name: "data.json", mime: "application/json", data: Buffer.from("{}") }] }) });
  manager["store"].db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(FAIL,'private diagnostic'); END");
  const { jobId } = manager.submit({ code: "result=2" }, "a", "rollback");
  const job = await terminal(manager, jobId);
  expect(job.status).toBe("failed"); expect(job.result).toBeUndefined();
  expect(job.error?.message).not.toContain("private diagnostic");
  expect(manager["store"].db.query("SELECT id FROM artifacts").all()).toEqual([]);
  expect(manager.available).toBe(false);
});

test("uncertain termination quarantines the lane instead of confirming cancellation", async () => {
  let executions = 0;
  const { manager } = await fixture({ environment: async () => environment(), execute: async (_request, context) => {
    executions++;
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new ComputeError("unavailable", "could not confirm stop", 503, true);
  } });
  const first = manager.submit({ code: "result=1" }, "a", "stop");
  const second = manager.submit({ code: "result=2" }, "a", "wait");
  await Bun.sleep(5);
  const stopped = await manager.cancel(first.jobId, "a");
  expect(stopped.status).toBe("failed"); expect(stopped.error?.code).toBe("unavailable");
  expect(manager.available).toBe(false); expect(manager.get(second.jobId, "a").status).toBe("queued");
  expect(executions).toBe(1);
});

test("compute close is bounded even if a defective executor ignores abort", async () => {
  let release!: () => void;
  const { manager } = await fixture({ environment: async () => environment(), execute: async () => {
    await new Promise<void>(resolve => { release = resolve; }); return result;
  } });
  manager.submit({ code: "result=2" }, "a", "hang"); await Bun.sleep(5);
  await manager.close(); await manager.close();
  expect(manager.available).toBe(false); release(); await Bun.sleep(5);
}, 5000);

test("compute deletion purges diagnostics and counts failed job storage", async () => {
  const { manager } = await fixture({ environment: async () => environment(), execute: async () => { throw new ComputeError("runtime_error", "private traceback"); } });
  const { jobId } = manager.submit({ code: "raise ValueError()" }, "a", "delete-error");
  await terminal(manager, jobId);
  expect(manager["store"].record(jobId)!.bytes).toBeGreaterThan(0);
  await manager.delete(jobId, "a");
  expect(manager["store"].record(jobId)!.state).not.toContain("private traceback");
  expect(manager["store"].record(jobId)!.request).toBeNull();
});
