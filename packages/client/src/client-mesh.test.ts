import { expect, test } from "bun:test";
import { LarmClient } from "./index";
const jobId = `meshjob_${"a".repeat(32)}`;
const job = { jobId, status: "queued", stage: "queued", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z", statusUrl: `/v1/3d/generations/${jobId}`, eventsUrl: `/v1/3d/generations/${jobId}/events` };
test("mesh SDK uses Control token, preserves the key and supports poll/search/cancel without retrying POST", async () => {
  const calls: { path: string; init?: RequestInit }[] = [], key = crypto.randomUUID();
  const client = new LarmClient({ baseUrl: "http://example.test", apiToken: "control-only", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push({ path, init });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-only");
    if (path.endsWith("/assets")) return Response.json({ assets: [], total: 0 });
    return Response.json(job, { status: init?.method === "POST" ? 202 : 200 });
  } });
  await client.mesh.generate({ source: { type: "prompt", prompt: "toy" } }, key);
  expect(new Headers(calls[0]!.init?.headers).get("idempotency-key")).toBe(key);
  expect(JSON.parse(String(calls[0]!.init?.body)).source.imageModel).toBe("qwen-image-2.1-turbo");
  await client.mesh.job(jobId); await client.mesh.list({ q: "ロボット" }); await client.mesh.cancel(jobId);
  expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  await expect(client.mesh.content("../escape")).rejects.toThrow();
});
