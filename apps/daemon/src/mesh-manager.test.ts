import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir, rename, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { meshGenerationRequestSchema, meshQuerySchema, InvalidMeshCursorError, createOpenApiDocument } from "@larm/core";
import { MeshManager } from "./mesh-manager";
import { MeshStore, MeshError, safeFile } from "./mesh-store";
import { registerMeshRoutes } from "./routes/mesh";
import { meshFixtureGlb } from "./mesh-fixture.test-helper";
import type { MeshProvider } from "./mesh-provider";
const roots: string[] = [], managers: MeshManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const input = () => meshGenerationRequestSchema.parse({ source: { type: "image-artifact", id: `image_${"a".repeat(32)}` }, title: "青緑のロボット ROBOT", tags: ["試作", "Robot"] });
async function setup(custom?: (root: string) => MeshProvider, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), "larm-mesh-test-")); roots.push(root);
  const store = new MeshStore(root, { freeFloorBytes: 0, workBytes: 0, ...opts });
  let generations = 0, images = 0;
  const provider: MeshProvider = custom?.(root) ?? { image: async () => { images++; return `image_${"b".repeat(32)}`; },
    generate: async (id, _seed, signal, stage) => {
      generations++; signal.throwIfAborted(); const dir = join(root, "work", id);
      await writeFile(join(dir, "cutout.png"), "cutout"); await writeFile(join(dir, "model.glb"), meshFixtureGlb()); await stage("stopping");
    } };
  const m = new MeshManager(store, provider, { copyImage: async () => ({ data: Buffer.from("source"), mimeType: "image/png" }) }); managers.push(m); await m.initialize();
  return { root, store, m, counts: () => ({ generations, images }) };
}
async function done(m: MeshManager, id: string) { for (let i = 0; i < 200; i++) { const j = m.get(id)!; if (["completed", "failed", "cancelled"].includes(j.status)) return j; await Bun.sleep(5); } throw new Error("job did not finish"); }
test("durable idempotency, pinning, publication, prompt chain, search edit, restart and deletion tombstones", async () => {
  const { root, store, m, counts } = await setup(), key = randomUUID();
  const first = await m.create(input(), key), same = await m.create(input(), key);
  expect(first.jobId).toBe(same.jobId);
  await expect(m.create({ ...input(), seed: 43 }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
  const job = await done(m, first.jobId); expect(job.status).toBe("completed"); expect(counts().generations).toBe(1);
  expect((await store.content(job.assetId!, "content"))!.data).toEqual(meshFixtureGlb());
  expect(store.list(meshQuerySchema.parse({ q: "ＲＯＢＯＴ ロボ", tags: "試作" })).total).toBe(1);
  await store.patch(job.assetId!, { title: "編集済み", tags: ["変更"] });
  expect(store.list(meshQuerySchema.parse({ q: "編集", tags: "変更" })).total).toBe(1);
  await m.close(); const restored = new MeshManager(new MeshStore(root, { freeFloorBytes: 0, workBytes: 0 }), { image: async () => { throw Error(); }, generate: async () => { throw Error(); } }, { copyImage: async () => undefined });
  managers.push(restored); await restored.initialize(); expect(restored.get(first.jobId)!.status).toBe("completed");
  expect(await restored.deleteAsset(job.assetId!)).toBe(true); expect(await restored.store.content(job.assetId!, "content")).toBeUndefined();
  expect((await restored.create(input(), key)).deleted).toBe(true);
  const saved = await readFile(join(root, "jobs", `${first.jobId}.json`), "utf8"); expect(saved).not.toContain("ロボット"); expect(saved).not.toContain("image_aaa");
  await expect(restored.create({ ...input(), title: "different" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await restored.deleteAsset(job.assetId!)).toBe(false);
  const prompt = await m.create({ ...input(), source: { type: "prompt", prompt: "toy" } }, randomUUID()).catch(() => undefined); expect(prompt).toBeUndefined();
});
test("prompt uses Qwen then the mesh provider and retains source provenance", async () => {
  const { m, counts } = await setup(); const j = await m.create({ ...input(), source: { type: "prompt", prompt: "青い玩具" } }, randomUUID());
  const result = await done(m, j.jobId); expect(result.status).toBe("completed"); expect(counts()).toEqual({ images: 1, generations: 1 }); expect(result.asset!.prompt).toBe("青い玩具");
});
test("invalid inputs, capacity and corrupt GLB fail without publishing", async () => {
  const { m } = await setup((root) => ({ image: async () => "unused", generate: async (id, _seed, _signal, stage) => {
    await writeFile(join(root, "work", id, "model.glb"), "broken"); await stage("stopping");
  } }));
  await expect(m.create(input(), "bad-key")).rejects.toMatchObject({ status: 400 });
  expect(meshGenerationRequestSchema.safeParse({ ...input(), resolution: 1024 }).success).toBe(false);
  expect(meshGenerationRequestSchema.safeParse({ ...input(), source: { type: "image-artifact", id: "/etc/passwd" } }).success).toBe(false);
  const j = await m.create(input(), randomUUID()); expect((await done(m, j.jobId)).status).toBe("failed"); expect(m.store.assets.size).toBe(0);
  const full = await setup(undefined, { maxBytes: 1024 }); await expect(full.m.create(input(), randomUUID())).rejects.toMatchObject({ status: 507 });
});
test("running cancellation stops only that job and queued cancellation does not start the provider", async () => {
  let started = 0, aborted = false;
  const { m } = await setup(() => ({ image: async () => "unused", generate: async (_id, _seed, signal) => {
    started++; await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
  } }));
  const a = await m.create(input(), randomUUID()); await Bun.sleep(20); const b = await m.create(input(), randomUUID());
  expect((await m.cancel(b.jobId))!.status).toBe("cancelled"); expect((await m.cancel(a.jobId))!.status).toBe("cancelled"); expect(started).toBe(1); expect(aborted).toBe(true);
});
test("SSE snapshot, Range, ETag, metadata patch and deletion endpoints work without a worker", async () => {
  const { m } = await setup(), j = await m.create(input(), randomUUID()), completed = await done(m, j.jobId), id = completed.assetId!;
  const app = new Hono(); registerMeshRoutes(app, { manager: m, maxBodyBytes: 65536, viewerPath: "/missing" });
  const events = await app.request(j.eventsUrl); expect(await events.text()).toContain('event: completed');
  const range = await app.request(`/v1/3d/assets/${id}/content`, { headers: { range: "bytes=0-11" } }); expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(12);
  const notModified = await app.request(`/v1/3d/assets/${id}/content`, { headers: { "if-none-match": range.headers.get("etag")! } }); expect(notModified.status).toBe(304);
  expect((await app.request(`/v1/3d/assets/${id}/content`, { headers: { range: "bytes=-0" } })).status).toBe(416);
  expect((await app.request(`/v1/3d/assets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "new" }) })).status).toBe(200);
  expect((await app.request(`/v1/3d/assets/${id}`, { method: "DELETE" })).status).toBe(204);
  for (const suffix of ["", "/content", "/source", "/metadata", "/preview"]) expect((await app.request(`/v1/3d/assets/${id}${suffix}`)).status).toBe(404);
});
test("crash after publication completes the original job, interrupted jobs fail, and trash finishes deletion", async () => {
  const { m, root } = await setup(); const first = await m.create(input(), randomUUID()), completed = await done(m, first.jobId); await m.close();
  const path = join(root, "jobs", `${first.jobId}.json`), record = JSON.parse(await readFile(path, "utf8")); record.job = { ...first, status: "running", stage: "stopping" }; await writeFile(path, JSON.stringify(record));
  const next = new MeshManager(new MeshStore(root, { freeFloorBytes: 0, workBytes: 0 }), { image: async () => "", generate: async () => { throw Error("must not regenerate"); } }, { copyImage: async () => undefined }); managers.push(next); await next.initialize(); expect(next.get(first.jobId)!.assetId).toBe(completed.assetId);
  const item = next.store.assets.get(completed.assetId!)!; await rename(item.directory, join(root, ".trash", completed.assetId!));
  const again = new MeshManager(new MeshStore(root), next.provider, { copyImage: async () => undefined }); managers.push(again); await again.initialize(); expect(again.get(first.jobId)!.deleted).toBe(true); expect(await readdir(join(root, ".trash"))).toEqual([]);
});
test("search cursors survive page boundary deletion and reject changed filters", async () => {
  const { m, store } = await setup();
  for (let i = 0; i < 3; i++) { const j = await m.create({ ...input(), title: `robot ${i}` }, randomUUID()); await done(m, j.jobId); }
  const page = store.list(meshQuerySchema.parse({ limit: 1 })); const cursor = page.nextCursor!; await m.deleteAsset(page.assets[0]!.id);
  const next = store.list(meshQuerySchema.parse({ limit: 1, cursor })); expect(next.assets).toHaveLength(1); expect(next.assets[0]!.id).not.toBe(page.assets[0]!.id);
  expect(() => store.list(meshQuerySchema.parse({ q: "robot", cursor }))).toThrow(InvalidMeshCursorError);
});
test("path containment rejects symlinks and external storage aliases", async () => {
  const { root } = await setup(); await symlink("/etc/passwd", join(root, "work", "escape")); await expect(safeFile(root, join(root, "work", "escape"), 65536)).rejects.toBeInstanceOf(MeshError);
  await symlink(root, join(root, "alias")); await expect(new MeshStore(join(root, "alias")).initialize()).rejects.toThrow();
});
test("OpenAPI publishes mesh operations, strict input and control authorization", () => {
  const doc = createOpenApiDocument("0.0.0") as any;
  expect(doc.paths["/v1/3d/generations"].post.parameters[0].name).toBe("Idempotency-Key");
  expect(doc.paths["/v1/3d/assets/{id}/content"].get.responses["206"]).toBeDefined();
  expect(doc.components.schemas.MeshGenerationRequest.additionalProperties).toBe(false);
});

test("stop failure keeps validated files private and recovery publishes without regenerating", async () => {
  const { m, root } = await setup((root) => ({ image: async () => "unused", generate: async (id, _seed, _signal, stage) => {
    const dir = join(root, "work", id); await writeFile(join(dir, "model.glb"), meshFixtureGlb()); await writeFile(join(dir, "cutout.png"), "cutout");
    await stage("stopping"); throw new MeshError("worker_stop_failed", 503, "stop failed");
  } }));
  const j = await m.create(input(), randomUUID()), result = await done(m, j.jobId); expect(result.error!.code).toBe("worker_stop_failed"); expect(m.store.assets.size).toBe(0);
  expect(await Bun.file(join(root, "work", j.jobId, "prepared.json")).exists()).toBe(true); await m.close();
  let generated = false;
  const recovery = new MeshManager(new MeshStore(root, { freeFloorBytes: 0, workBytes: 0 }), { image: async () => "", generate: async () => { generated = true; } }, { copyImage: async () => undefined });
  managers.push(recovery); await recovery.initialize(); expect(recovery.get(j.jobId)!.status).toBe("completed"); expect(generated).toBe(false); expect(recovery.store.assets.size).toBe(1);
});

test("a deletion intent wins over a validated pre-completion recovery result", async () => {
  const { m, store, root } = await setup(), j = await m.create(input(), randomUUID()), completed = await done(m, j.jobId); await m.close();
  const work = join(root, "work", j.jobId); await mkdir(work);
  await writeFile(join(work, "model.glb"), meshFixtureGlb()); await writeFile(join(work, "source.image"), "source"); await writeFile(join(work, "cutout.png"), "cutout"); await writeFile(join(work, "prepared.json"), JSON.stringify(completed.asset));
  const path = join(root, "jobs", `${j.jobId}.json`), record = JSON.parse(await readFile(path, "utf8")); record.job = { ...j, status: "running", stage: "stopping" }; await writeFile(path, JSON.stringify(record));
  await expect(store.remove(completed.assetId!, async () => { throw new Error("crash before redaction"); })).rejects.toThrow();
  const recovery = new MeshManager(new MeshStore(root), m.provider, { copyImage: async () => undefined }); managers.push(recovery); await recovery.initialize();
  expect(recovery.get(j.jobId)!.deleted).toBe(true); expect(recovery.store.assets.size).toBe(0); expect(await readdir(join(root, "work"))).toEqual([]);
});

test("worker quarantine disables new inference while saved assets remain available", async () => {
  const { m, root } = await setup(), j = await m.create(input(), randomUUID()), result = await done(m, j.jobId); await m.close();
  const offline = new MeshManager(new MeshStore(root), m.provider, { copyImage: async () => undefined, workerAvailable: () => false }); managers.push(offline); await offline.initialize();
  expect(offline.store.get(result.assetId!)!.id).toBe(result.assetId!);
  expect((await offline.store.content(result.assetId!, "content"))!.data).toEqual(meshFixtureGlb());
  await expect(offline.create(input(), randomUUID())).rejects.toMatchObject({ status: 503 });
});

test("an unreadable journal disables new generation and preserves its private work", async () => {
  const { m, root } = await setup(); await m.close(); const id = `meshjob_${"c".repeat(32)}`;
  await writeFile(join(root, "jobs", `${id}.json`), "truncated journal"); await mkdir(join(root, "work", id)); await writeFile(join(root, "work", id, "source.image"), "private input");
  const recovery = new MeshManager(new MeshStore(root), m.provider, { copyImage: async () => undefined }); managers.push(recovery); await recovery.initialize();
  expect(await Bun.file(join(root, "work", id, "source.image")).text()).toBe("private input");
  await expect(recovery.create(input(), randomUUID())).rejects.toMatchObject({ status: 503 });
});

test("HTTP handlers preserve domain error statuses through Hono composition", async () => {
  const { m } = await setup(), app = new Hono(); registerMeshRoutes(app, { manager: m, maxBodyBytes: 65536, viewerPath: "/missing" });
  const send = (key: string, body: unknown) => app.request("/v1/3d/generations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  expect((await send("bad-key", input())).status).toBe(400);
  const key = randomUUID(), accepted = await send(key, input()); expect(accepted.status).toBe(202);
  const conflict = await send(key, { ...input(), seed: 43 }); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
  expect((await app.request("/v1/3d/assets?cursor=invalid")).status).toBe(400);
  const full = await setup(undefined, { maxBytes: 1024 }), fullApp = new Hono(); registerMeshRoutes(fullApp, { manager: full.m, maxBodyBytes: 65536, viewerPath: "/missing" });
  expect((await fullApp.request("/v1/3d/generations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(input()) })).status).toBe(507);
});
