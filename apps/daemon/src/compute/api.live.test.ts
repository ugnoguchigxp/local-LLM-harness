import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeError, type ComputeJob } from "@larm/core";
import { LinuxCpuComputeExecutor } from "@larm/backends";
import { ComputeManager } from "./manager";
import { registerComputeRoutes } from "../routes/compute";
import { LarmClient } from "../../../../packages/client/src/index";

test.skipIf(!process.env.LARM_COMPUTE_TEST_RUNTIME)("CPU API executes real Python, serves PNG, replays keys and cancels work", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-compute-api-live-"));
  const manager = new ComputeManager({ root, executor: new LinuxCpuComputeExecutor({
    runtimeRoot: process.env.LARM_COMPUTE_TEST_RUNTIME!,
    runner: new URL("../../../compute-cpu/runner.py", import.meta.url).pathname,
    requirements: new URL("../../../compute-cpu/requirements.txt", import.meta.url).pathname,
  }) });
  await manager.initialize();
  const app = new Hono();
  app.onError((error, c) => error instanceof ComputeError
    ? c.json({ error: { code: error.code, message: error.message } }, error.status)
    : c.json({ error: { code: "unavailable", message: "test API failure" } }, 503));
  registerComputeRoutes(app, { manager, apiToken: "test-compute-control-token" });
  const client = new LarmClient({ baseUrl: "http://test-control", apiToken: "test-compute-control-token",
    fetch: async (url, init) => app.request(String(url), init) });
  async function wait(id: string, condition: (job: ComputeJob) => boolean) {
    for (let count = 0; count < 200; count++) {
      const job = await client.compute.get(id);
      if (condition(job)) return job;
      await Bun.sleep(50);
    }
    throw new Error("live API job did not reach expected state");
  }
  try {
    const env = await client.compute.environment(); expect(env.python).not.toBe("test");
    const body = { code: "import numpy as np\nimport matplotlib.pyplot as plt\nplt.plot(inputs['x'])\nreport('done', 1.0)\nresult = int(np.sum(inputs['x']))", inputs: { x: [1, 2, 3] }, timeoutSec: 15 };
    const receipt = await client.compute.submit(body, "real-calculation");
    expect(await client.compute.submit(body, "real-calculation")).toEqual(receipt);
    const completed = await wait(receipt.jobId, job => !["queued", "running"].includes(job.status));
    expect(completed.status).toBe("completed"); expect(completed.result?.value).toBe(6);
    expect(completed.progress?.ratio).toBe(1);
    const artifact = await client.compute.artifact(receipt.jobId, completed.result!.artifacts[0]!.id);
    expect(artifact.headers.get("content-type")).toBe("image/png");
    expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const active = await client.compute.submit({ code: "while True: pass" }, "real-cancellation");
    await wait(active.jobId, job => job.stage === "running");
    const cancelled = await client.compute.cancel(active.jobId);
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.result).toBeUndefined();
    expect(await client.compute.delete(receipt.jobId)).toBeUndefined();
    await expect(client.compute.submit(body, "real-calculation")).rejects.toMatchObject({ code: "job_expired", status: 410 });
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
