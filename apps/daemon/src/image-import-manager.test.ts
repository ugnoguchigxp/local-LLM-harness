import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { IMAGE_IMPORT_LIMITS, createOpenApiDocument, imageImportReceiptSchema, meshGenerationRequestSchema } from "@larm/core";
import { ImageImportError, type ImageNormalizer } from "@larm/backends";
import { ImageArtifactManager } from "./image-artifact-manager";
import { ImageImportManager } from "./image-import-manager";
import { registerImageArtifactRoutes } from "./routes/image-artifacts";
import { MeshManager } from "./mesh-manager";
import { MeshStore } from "./mesh-store";
import { meshFixtureGlb } from "./mesh-fixture.test-helper";
const fixtures: { root: string; images: ImageArtifactManager; imports: ImageImportManager }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.imports.drain(); f.images.close(); await rm(f.root, { recursive: true, force: true }); } });
async function setup(normalize?: ImageNormalizer, maxBytes = 100_000_000, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "larm-image-import-"));
  const images = new ImageArtifactManager(root, { maxBytes, targetBytes: Math.floor(maxBytes * 0.9) }); await images.initialize();
  let calls = 0;
  const imports = new ImageImportManager(images, async (bytes, mime, path) => { calls++; if (normalize) return normalize(bytes, mime, path); await writeFile(path, bytes); return { width: 8, height: 6, hasAlpha: true, bytes: bytes.length, format: "webp" }; }, now);
  await imports.initialize(); const f = { root, images, imports }; fixtures.push(f);
  const app = new Hono(); registerImageArtifactRoutes(app, images, imports, true);
  const post = (key: string, data: Uint8Array = Buffer.from("image pixels"), extras = false) => {
    const body = new FormData(); body.append("file", new Blob([data], { type: "image/webp" }), "private-location.webp"); if (extras) body.append("url", "https://example.invalid/photo");
    return app.request("/v1/image-artifacts/imports", { method: "POST", headers: { authorization: "Bearer test-control", "idempotency-key": key }, body });
  };
  return { ...f, app, post, calls: () => calls };
}
const source = Buffer.from("image pixels");
test("parallel identical bytes replay one import; conflict, ownership, deletion and restart never recreate", async () => {
  const f = await setup(), key = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.imports.import("owner", key, source, "image/webp")));
  expect(results.filter(v => v.status === 201)).toHaveLength(1); expect(f.calls()).toBe(1);
  const receipt = results[0]!.receipt; expect(receipt.status).toBe("succeeded");
  if (receipt.status !== "succeeded" || receipt.deleted) throw Error();
  const id = receipt.artifact.id;
  expect(receipt.artifact).not.toHaveProperty("model"); expect(receipt.artifact).not.toHaveProperty("seed"); expect(receipt.artifact).not.toHaveProperty("steps");
  expect((await f.images.list()).images.map(v => v.id)).toEqual([id]); expect((await f.images.copyForMesh(id))!.data).toEqual(source);
  await expect(f.imports.import("owner", key, Buffer.from("other"), "image/webp")).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  await expect(f.imports.receipt("other", key)).rejects.toMatchObject({ status: 404 });
  const restarted = new ImageImportManager(f.images, async () => { throw Error("must not decode"); }); await restarted.initialize();
  expect(await restarted.receipt("owner", key)).toEqual(receipt);
  expect(await restarted.removeArtifact(id)).toBe(true);
  const replay = await restarted.import("owner", key, source, "image/webp");
  expect(replay.status).toBe(200); expect(replay.receipt).toMatchObject({ status: "succeeded", deleted: true, artifactId: id }); expect(replay.receipt).not.toHaveProperty("artifact");
  const again = new ImageImportManager(f.images, async () => { throw Error(); }); await again.initialize();
  expect((await again.import("owner", key, source, "image/webp")).receipt).toMatchObject({ deleted: true }); expect((await f.images.list()).images).toHaveLength(0);
  const receiptFiles = await readdir(join(f.imports.root, "receipts"));
  const saved = await readFile(join(f.imports.root, "receipts", receiptFiles[0]!), "utf8"); expect(saved).not.toContain('"owner"'); expect(saved).not.toContain("private-location");
});
test("HTTP import returns existing artifact URLs, status receipt, rejects malformed multipart and key conflict", async () => {
  const f = await setup(), key = randomUUID();
  const first = await f.post(key); expect(first.status).toBe(201);
  const receipt = imageImportReceiptSchema.parse(await first.json()); if (receipt.status !== "succeeded" || receipt.deleted) throw Error();
  expect(first.headers.get("location")).toBe(`/v1/image-imports/${key}`);
  expect((await f.post(key)).status).toBe(200); expect((await f.post(key, Buffer.from("different"))).status).toBe(409);
  expect((await f.post("invalid")).status).toBe(400); expect((await f.post(randomUUID(), source, true)).status).toBe(400);
  const status = await f.app.request(receipt.statusUrl, { headers: { authorization: "Bearer test-control" } }); expect(await status.json()).toEqual(receipt);
  expect((await f.app.request(receipt.artifact.contentUrl)).headers.get("content-type")).toBe("image/webp");
  expect(await (await f.app.request(receipt.artifact.contentUrl)).text()).toBe(source.toString());
  expect((await f.app.request(`/v1/image-artifacts/${receipt.artifact.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await f.app.request(receipt.artifact.contentUrl)).status).toBe(404);
  expect(await (await f.post(key)).json()).toMatchObject({ status: "succeeded", deleted: true });
  expect((await f.app.request(`/v1/image-imports/${randomUUID()}`, { headers: { authorization: "Bearer test-control" } })).status).toBe(404);
  expect((await f.app.request("/v1/image-imports/not-a-uuid")).status).toBe(400);
});
test("pending receipt survives a lost response, same-key concurrent resend does not decode twice, queue is bounded", async () => {
  let release!: () => void; const hold = new Promise<void>(r => release = r);
  const f = await setup(async (data, _mime, path) => { await hold; await writeFile(path, data); return { width: 2, height: 2, hasAlpha: false, bytes: data.length, format: "png" }; });
  const key = randomUUID(), first = await f.imports.import("owner", key, source, "image/png", 0);
  expect(first.status).toBe(202); expect((await f.imports.receipt("owner", key)).status).toBe("pending");
  expect((await f.imports.import("owner", key, source, "image/png", 0)).status).toBe(202);
  for (let i = 0; i < 3; i++) await f.imports.import("owner", randomUUID(), source, "image/png", 0);
  await expect(f.imports.import("owner", randomUUID(), source, "image/png", 0)).rejects.toMatchObject({ status: 429 });
  release(); await f.imports.drain(); expect(f.calls()).toBe(4); expect((await f.imports.receipt("owner", key)).status).toBe("succeeded");
});
test("expired keys return 410, capacity refuses without deleting saved images, failures replay and clean work", async () => {
  let now = Date.now(); const f = await setup(undefined, 100_000, () => now), key = randomUUID();
  await f.imports.import("owner", key, source, "image/webp"); now += IMAGE_IMPORT_LIMITS.receiptTtlMs;
  await expect(f.imports.receipt("owner", key)).rejects.toMatchObject({ status: 410 });
  await expect(f.imports.import("owner", key, source, "image/webp")).rejects.toMatchObject({ status: 410 });
  const full = await setup(undefined, 100_000), before = await full.imports.import("owner", randomUUID(), source, "image/webp"); expect(before.status).toBe(201);
  const rejected = await full.imports.import("owner", randomUUID(), new Uint8Array(60_000), "image/webp"); expect(rejected.status).toBe(507);
  expect((await full.images.list()).images).toHaveLength(1);
  const fail = await setup(async () => { throw new ImageImportError("invalid_image", 400); }), badKey = randomUUID();
  expect((await fail.imports.import("owner", badKey, source, "image/png")).status).toBe(400);
  expect((await fail.imports.import("owner", badKey, source, "image/png")).status).toBe(400); expect(fail.calls()).toBe(1);
  expect((await fail.imports.receipt("owner", badKey)).status).toBe("failed"); expect(await readdir(join(fail.imports.root, "work"))).toEqual([]);
});
test("crash after rename recovers success; pre-publication crash fails; corrupt receipt preserves private work", async () => {
  const f = await setup(), key = randomUUID(); await f.imports.import("owner", key, source, "image/webp");
  const file = join(f.imports.root, "receipts", (await readdir(join(f.imports.root, "receipts")))[0]!);
  const saved = JSON.parse(await readFile(file, "utf8")); saved.status = "pending"; await writeFile(file, JSON.stringify(saved));
  const restored = new ImageImportManager(f.images, async () => { throw Error(); }); await restored.initialize(); expect((await restored.receipt("owner", key)).status).toBe("succeeded");
  saved.status = "pending"; await f.images.delete(saved.artifactId); await writeFile(file, JSON.stringify(saved));
  const interrupted = new ImageImportManager(f.images, async () => { throw Error(); }); await interrupted.initialize();
  expect(await interrupted.receipt("owner", key)).toMatchObject({ status: "failed", error: { code: "image_import_interrupted" } });
  expect((await interrupted.import("owner", key, source, "image/webp")).status).toBe(503);
  await mkdir(join(f.imports.root, "work", "keep")); await writeFile(join(f.imports.root, "work", "keep", "private"), "keep"); await writeFile(file, "broken");
  const corrupt = new ImageImportManager(f.images, async () => { throw Error(); }); await corrupt.initialize(); expect(corrupt.ready).toBe(false);
  expect(await readFile(join(f.imports.root, "work", "keep", "private"), "utf8")).toBe("keep");
});
test("durable deletion intent completes physical removal on restart", async () => {
  const f = await setup(), key = randomUUID(); const result = await f.imports.import("owner", key, source, "image/webp");
  const file = join(f.imports.root, "receipts", (await readdir(join(f.imports.root, "receipts")))[0]!);
  const saved = JSON.parse(await readFile(file, "utf8")); saved.deleted = true; await writeFile(file, JSON.stringify(saved));
  const restarted = new ImageImportManager(f.images, async () => { throw Error(); }); await restarted.initialize();
  expect(await restarted.receipt("owner", key)).toMatchObject({ status: "succeeded", deleted: true }); expect((await f.images.list()).images).toHaveLength(0); expect(result.status).toBe(201);
});
test("imported image ID flows into the existing 3D manager and protected source copy", async () => {
  const f = await setup(); const imported = (await f.imports.import("owner", randomUUID(), source, "image/webp")).receipt;
  if (imported.status !== "succeeded" || imported.deleted) throw Error();
  const meshRoot = join(f.root, "mesh-test"); await mkdir(meshRoot);
  let generations = 0;
  const mesh = new MeshManager(new MeshStore(meshRoot, { freeFloorBytes: 0, workBytes: 0 }), {
    image: async () => { throw Error("must not generate a source image"); },
    generate: async (id, _seed, _signal, stage) => { generations++; await writeFile(join(meshRoot, "work", id, "cutout.png"), source); await writeFile(join(meshRoot, "work", id, "model.glb"), meshFixtureGlb()); await stage("stopping"); },
  }, { copyImage: id => f.images.copyForMesh(id) });
  await mesh.initialize();
  try {
    const job = await mesh.create(meshGenerationRequestSchema.parse({ source: { type: "image-artifact", id: imported.artifact.id } }), randomUUID());
    for (let i = 0; i < 200 && !["completed", "failed"].includes(mesh.get(job.jobId)!.status); i++) await Bun.sleep(5);
    const complete = mesh.get(job.jobId)!; expect(complete.status).toBe("completed"); expect(generations).toBe(1);
    expect((await mesh.store.content(complete.assetId!, "source"))!.data).toEqual(source);
  } finally { await mesh.close(); }
});
test("OpenAPI publishes multipart import, receipt, errors and Control authentication", () => {
  const spec = createOpenApiDocument("test") as any;
  const post = spec.paths["/v1/image-artifacts/imports"].post;
  expect(post.security).toEqual([{ bearerAuth: [] }]); expect(post.requestBody.content["multipart/form-data"].schema.required).toEqual(["file"]);
  expect(post.parameters[0].name).toBe("Idempotency-Key"); expect(post.responses["201"]).toBeDefined(); expect(post.responses["202"]).toBeDefined();
  expect(spec.paths["/v1/image-imports/{requestId}"].get).toBeDefined(); expect(spec.components.schemas.ImageImportReceipt).toBeDefined();
});
