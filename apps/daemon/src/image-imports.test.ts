import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IMAGE_IMPORT_MAX_BODY_BYTES, IMAGE_IMPORT_MAX_BYTES, createOpenApiDocument, imageArtifactSchema } from "@larm/core";
import { ImageArtifactManager } from "./image-artifact-manager";
import { createAppRequestPolicy } from "./app-request-policy";
import type { AppDeps } from "./app-types";
import { registerImageImportRoutes } from "./routes/image-imports";
import { registerImageArtifactRoutes } from "./routes/image-artifacts";
import { withAbort } from "./http-body";

const roots: string[] = [];
const managers: ImageArtifactManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const identity = { version: "test", releaseCommit: "test", configRevision: "test", bootEpoch: "test" };
function routes(manager?: ImageArtifactManager, apiToken: string | null = "secret") {
  const app = new Hono();
  app.use("*", createAppRequestPolicy({ apiToken: apiToken ?? undefined, protectedConsumerToken: "protected" } as AppDeps, identity));
  registerImageImportRoutes(app, manager);
  registerImageArtifactRoutes(app, manager);
  return app;
}
async function fixture(maxBytes = 20_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), "larm-image-import-"));
  roots.push(root);
  const manager = await openManager(root, maxBytes);
  return { root, manager, app: routes(manager) };
}
async function openManager(root: string, maxBytes = 20_000_000_000) {
  const manager = new ImageArtifactManager(root, { maxBytes, targetBytes: Math.floor(maxBytes * 0.9) });
  managers.push(manager);
  await manager.initialize();
  return manager;
}
async function image(width = 24, height = 12, alpha = true) {
  return await sharp({ create: { width, height, channels: alpha ? 4 : 3,
    background: { r: 37, g: 96, b: 148, alpha: alpha ? 0.35 : 1 } } }).webp({ quality: 75 }).toBuffer();
}
function upload(app: Hono, bytes: Buffer, key: string = crypto.randomUUID(), options: { mime?: string; token?: string; filename?: string; form?: FormData; signal?: AbortSignal } = {}) {
  const form = options.form ?? new FormData();
  if (!options.form) form.append("file", new File([bytes], options.filename ?? "photo.webp", { type: options.mime ?? "image/webp" }));
  return app.request("/v1/image-artifacts/imports", { method: "POST", body: form, signal: options.signal,
    headers: { authorization: `Bearer ${options.token ?? "secret"}`, "idempotency-key": key } });
}
function lookup(app: Hono, key: string, token = "secret") {
  return app.request(`/v1/image-imports/${key}`, { headers: { authorization: `Bearer ${token}` } });
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
async function receiptPath(root: string) {
  const directory = join(root, ".image-imports");
  return join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
}

test("quality-75 WebP and alpha survive byte-for-byte, and use the existing library contract", async () => {
  const { app, manager } = await fixture();
  const bytes = await image();
  const response = await upload(app, bytes);
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toMatch(/^\/v1\/image-imports\//);
  const artifact = imageArtifactSchema.parse(await response.json());
  expect(artifact).toMatchObject({ format: "webp", mimeType: "image/webp", width: 24, height: 12, hasAlpha: true,
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  expect(artifact.model).toBeUndefined(); expect(artifact.seed).toBeUndefined(); expect(artifact.steps).toBeUndefined();
  expect(await (await app.request(`/v1/image-artifacts/${artifact.id}`, { headers: { authorization: "Bearer secret" } })).json()).toEqual(artifact);
  const content = await app.request(artifact.contentUrl, { headers: { authorization: "Bearer secret" } });
  expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
  const raw = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  expect(raw.info.channels).toBe(4);
  expect(raw.data[3]).toBeGreaterThan(0); expect(raw.data[3]).toBeLessThan(255);
  expect((await manager.list()).images).toEqual([artifact]);
  const list = await app.request("/v1/image-artifacts", { headers: { authorization: "Bearer secret" } });
  expect((await list.json() as any).images).toEqual([artifact]);
});

test("2000 x 2000 is accepted; either axis at 2001 is rejected without publication", async () => {
  const { app, manager } = await fixture();
  expect((await upload(app, await image(2000, 2000, false))).status).toBe(200);
  await error(await upload(app, await image(2001, 1)), 413, "image_dimensions_exceeded");
  await error(await upload(app, await image(1, 2001)), 413, "image_dimensions_exceeded");
  await error(await upload(app, await image(2001, 2001)), 413, "image_dimensions_exceeded");
  expect((await manager.list()).images).toHaveLength(1);
});

test("concurrent retries, changed multipart names, response loss and restart retain one artifact", async () => {
  const { app, manager, root } = await fixture();
  const bytes = await image(); const key = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => upload(app, bytes, key,
    { filename: `different-${index}.webp` })));
  const artifacts = await Promise.all(responses.map(async (response) => {
    expect(response.status).toBe(200); return await response.json() as any;
  }));
  expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(1);
  expect((await manager.list()).images).toHaveLength(1);
  manager.close();
  const restarted = await openManager(root);
  const resumed = routes(restarted);
  expect(await (await lookup(resumed, key.toUpperCase())).json()).toMatchObject({ status: "succeeded", artifact: artifacts[0] });
  expect(await (await upload(resumed, bytes, key)).json()).toEqual(artifacts[0]);
  // A caller that discards/loses the response can recover exclusively by UUID.
  const lostKey = crypto.randomUUID();
  const lost = await upload(resumed, bytes, lostKey); await lost.body?.cancel();
  expect((await (await lookup(resumed, lostKey)).json() as any).status).toBe("succeeded");
  expect((await restarted.list()).images).toHaveLength(2);
});

test("different content conflicts, credentials isolate receipts, and explicit deletion never resurrects", async () => {
  const { app, manager, root } = await fixture();
  const bytes = await image(); const key = crypto.randomUUID();
  const artifact = imageArtifactSchema.parse(await (await upload(app, bytes, key)).json());
  await error(await upload(app, await image(30, 30), key), 409, "idempotency_conflict");
  await error(await upload(app, bytes, key, { mime: "image/png" }), 409, "idempotency_conflict");
  await error(await lookup(app, key, "protected"), 404, "image_import_not_found");
  const other = imageArtifactSchema.parse(await (await upload(app, bytes, key, { token: "protected" })).json());
  expect(other.id).not.toBe(artifact.id);
  expect((await app.request(`/v1/image-artifacts/${artifact.id}`, { method: "DELETE", headers: { authorization: "Bearer secret" } })).status).toBe(200);
  manager.close();
  const resumed = routes(await openManager(root));
  await error(await upload(resumed, bytes, key), 410, "image_artifact_deleted");
  expect((await (await lookup(resumed, key)).json() as any).status).toBe("deleted");
  expect((await app.request(artifact.contentUrl, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
});

test("unsupported formats, spoofed MIME, corrupt payloads and animation have distinct errors", async () => {
  const { app, manager } = await fixture();
  const webp = await image();
  await error(await upload(app, webp, undefined, { mime: "image/png" }), 415, "unsupported_image_format");
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from("not an image"),
    await sharp(webp).png().toBuffer(), await sharp(webp).jpeg().toBuffer(), Buffer.from("\0\0\0\x18ftypmp42")]) {
    await error(await upload(app, bytes), 415, "unsupported_image_format");
  }
  await error(await upload(app, webp.subarray(0, webp.length - 4)), 422, "invalid_image");
  // Valid RIFF framing and VP8 headers with damaged compressed pixels must fail full decode.
  const pixels = Buffer.alloc(128 * 128 * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 73 + (index >> 3) * 37) % 256;
  const broken = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).webp({ quality: 75 }).toBuffer();
  broken.fill(255, 32);
  expect((await sharp(broken).metadata()).width).toBe(128);
  await error(await upload(app, broken), 422, "invalid_image");
  const animated = await sharp({ create: { width: 4, height: 8, channels: 4,
    background: { r: 1, g: 2, b: 3, alpha: 1 } } }).raw().toBuffer();
  animated.fill(200, animated.length / 2);
  const animation = await sharp(animated, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  await error(await upload(app, animation), 415, "animated_image_not_supported");
  expect((await manager.list()).images).toHaveLength(0);
});

test("authentication, UUID and single-part validation happen before publication", async () => {
  const { app, manager } = await fixture(); const bytes = await image();
  await error(await upload(app, bytes, undefined, { token: "wrong" }), 401, "unauthorized");
  await error(await lookup(app, crypto.randomUUID(), "wrong"), 401, "unauthorized");
  await error(await upload(routes(manager, null), bytes), 401, "unauthorized");
  await error(await upload(app, bytes, "not-a-uuid"), 400, "invalid_idempotency_key");
  await error(await lookup(app, "not-a-uuid"), 400, "invalid_idempotency_key");
  const empty = new FormData();
  await error(await upload(app, bytes, undefined, { form: empty }), 400, "invalid_multipart");
  const other = new FormData(); other.append("other", "unaccepted");
  await error(await upload(app, bytes, undefined, { form: other }), 400, "invalid_multipart");
  const duplicate = new FormData(); duplicate.append("file", new File([bytes], "a.webp", { type: "image/webp" }));
  duplicate.append("file", new File([bytes], "b.webp", { type: "image/webp" }));
  await error(await upload(app, bytes, undefined, { form: duplicate }), 400, "invalid_multipart");
  const fields = new FormData(); fields.append("file", "not-a-file");
  await error(await upload(app, bytes, undefined, { form: fields }), 400, "invalid_multipart");
  const extra = new FormData(); extra.append("file", new File([bytes], "photo.webp", { type: "image/webp" })); extra.append("caption", "unused");
  await error(await upload(app, bytes, undefined, { form: extra }), 400, "invalid_multipart");
  const wrong = new FormData(); wrong.append("image", new File([bytes], "photo.webp", { type: "image/webp" }));
  await error(await upload(app, bytes, undefined, { form: wrong }), 400, "invalid_multipart");
  await error(await upload(routes(), bytes), 503, "not_configured");
  expect((await manager.list()).images).toHaveLength(0);
});

test("a truncated multipart never creates a receipt and the identical key can be retried", async () => {
  const { app } = await fixture(); const key = crypto.randomUUID();
  await error(await app.request("/v1/image-artifacts/imports", { method: "POST", body: "--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.webp\"\r\nContent-Type: image/webp\r\n\r\nRIFF",
    headers: { authorization: "Bearer secret", "idempotency-key": key, "content-type": "multipart/form-data; boundary=test" } }), 400, "invalid_multipart");
  await error(await lookup(app, key), 404, "image_import_not_found");
  expect((await upload(app, await image(), key)).status).toBe(200);
});

test("file and streaming multipart byte limits are enforced before decoding", async () => {
  const { app, manager } = await fixture();
  await error(await upload(app, Buffer.alloc(IMAGE_IMPORT_MAX_BYTES + 1)), 413, "image_too_large");
  const key = crypto.randomUUID();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(IMAGE_IMPORT_MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } });
  await error(await app.request("/v1/image-artifacts/imports", { method: "POST", body, duplex: "half",
    headers: { authorization: "Bearer secret", "idempotency-key": key, "content-type": "multipart/form-data; boundary=test" } }), 413, "body_too_large");
  await error(await lookup(app, key), 404, "image_import_not_found");
  expect((await manager.list()).images).toHaveLength(0);
});

test("the inclusive 16 MiB boundary accepts a decodable static WebP", async () => {
  const { app } = await fixture(); const original = await image();
  // WebP permits unknown RIFF chunks; padding exercises the exact transport limit.
  const padded = Buffer.alloc(IMAGE_IMPORT_MAX_BYTES); original.copy(padded);
  padded.write("JUNK", original.length); padded.writeUInt32LE(padded.length - original.length - 8, original.length + 4);
  padded.writeUInt32LE(padded.length - 8, 4);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const form = new FormData(); form.append("file", new File([padded], "photo.webp", { type: "image/webp" }));
    const response = await fetch(new URL("/v1/image-artifacts/imports", server.url), { method: "POST", body: form,
      headers: { authorization: "Bearer secret", "idempotency-key": crypto.randomUUID() } });
    expect(response.status).toBe(200);
    expect(imageArtifactSchema.parse(await response.json()).bytes).toBe(IMAGE_IMPORT_MAX_BYTES);
  } finally { await server.stop(true); }
});

test("a real HTTP response disconnect leaves a discoverable result without a second write", async () => {
  const { app, manager } = await fixture(); const bytes = await image(); const key = crypto.randomUUID();
  let acknowledge!: () => void; const committed = new Promise<void>((resolve) => { acknowledge = resolve; });
  let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const response = await app.fetch(request);
    if (request.method === "POST") { acknowledge(); await gate; }
    return response;
  } });
  const abort = new AbortController();
  try {
    const form = new FormData(); form.append("file", new File([bytes], "photo.webp", { type: "image/webp" }));
    const response = fetch(new URL("/v1/image-artifacts/imports", server.url), { method: "POST", body: form, signal: abort.signal,
      headers: { authorization: "Bearer secret", "idempotency-key": key } }).then(() => "received", () => "disconnected");
    await withAbort(committed, AbortSignal.timeout(5000));
    abort.abort(); unblock(); expect(await response).toBe("disconnected");
    const status = await (await lookup(app, key)).json() as any;
    expect(status.status).toBe("succeeded");
    expect(await (await upload(app, bytes, key)).json()).toEqual(status.artifact);
    expect((await manager.list()).images).toHaveLength(1);
  } finally { abort.abort(); unblock(); await server.stop(true); }
});

test("SIGKILL before publication and after rename preserves at-most-once behavior across processes", async () => {
  for (const phase of ["before-publication", "after-publication"]) {
    const root = await mkdtemp(join(tmpdir(), "larm-import-crash-")); roots.push(root);
    const bytes = await image(); const key = crypto.randomUUID();
    const input = join(root, "input.webp"); await writeFile(input, bytes);
    const script = `
      import { ImageArtifactManager } from ${JSON.stringify(join(import.meta.dir, "image-artifact-manager.ts"))};
      import { ImageImportStore } from ${JSON.stringify(join(import.meta.dir, "image-import-store.ts"))};
      const manager = new ImageArtifactManager(${JSON.stringify(root)}); await manager.initialize();
      const original = ImageImportStore.prototype.save;
      const hold = async () => { setInterval(() => {}, 1000); console.log("checkpoint"); await new Promise(() => {}); };
      ImageImportStore.prototype.save = async function(path, receipt) {
        if (${JSON.stringify(phase)} === "after-publication" && receipt.result.status === "succeeded") await hold();
        await original.call(this, path, receipt);
        if (${JSON.stringify(phase)} === "before-publication" && receipt.result.status === "pending" && receipt.metadata) await hold();
      };
      await manager.importImage("test-principal", ${JSON.stringify(key)}, Buffer.from(await Bun.file(${JSON.stringify(input)}).arrayBuffer()), "image/webp");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    try {
      const checkpoint = await withAbort(reader.read(), AbortSignal.timeout(5000));
      expect(new TextDecoder().decode(checkpoint.value)).toContain("checkpoint");
    } finally { child.kill("SIGKILL"); await child.exited; reader.releaseLock(); }
    const manager = await openManager(root);
    const receipt = await manager.getImport("test-principal", key);
    if (phase === "after-publication") {
      expect(receipt?.status).toBe("succeeded");
      expect(await manager.importImage("test-principal", key, bytes, "image/webp")).toEqual(receipt!.artifact!);
      expect((await manager.list()).images).toHaveLength(1);
    } else {
      expect(receipt?.status).toBe("failed");
      await expect(manager.importImage("test-principal", key, bytes, "image/webp")).rejects.toMatchObject({ code: "image_import_interrupted" });
      expect((await manager.list()).images).toHaveLength(0);
    }
    expect(await readdir(join(root, ".image-imports", "staging"))).toEqual([]);
  }
});

test("pool capacity exhaustion preserves existing images and records a terminal failure", async () => {
  const { app, manager, root } = await fixture(700);
  const bytes = await image(); const first = imageArtifactSchema.parse(await (await upload(app, bytes)).json());
  expect(first.id).toBeDefined();
  const key = crypto.randomUUID();
  await error(await upload(app, bytes, key), 507, "image_storage_full");
  expect((await (await lookup(app, key)).json() as any).error).toMatchObject({ code: "image_storage_full", httpStatus: 507 });
  expect((await manager.list()).images.map((artifact) => artifact.id)).toEqual([first.id]);
  expect(await readdir(join(root, ".image-imports", "staging"))).toEqual([]);
  await manager.delete(first.id);
  await error(await upload(app, bytes, key), 507, "image_storage_full");
  expect((await manager.list()).images).toEqual([]);
});

test("filesystem failure cleans staging, leaves the library empty and replays the saved failure", async () => {
  const { app, manager, root } = await fixture();
  await symlink(tmpdir(), join(root, new Date().getUTCFullYear().toString()));
  const bytes = await image(); const key = crypto.randomUUID();
  await error(await upload(app, bytes, key), 500, "image_storage_failed");
  expect((await manager.list()).images).toEqual([]);
  expect(await readdir(join(root, ".image-imports", "staging"))).toEqual([]);
  await error(await upload(app, bytes, key), 500, "image_storage_failed");
});

test("restart recovers publication before receipt commit, and never republishes missing content", async () => {
  for (const published of [true, false]) {
    const { app, manager, root } = await fixture();
    const bytes = await image(); const key = crypto.randomUUID();
    const artifact = imageArtifactSchema.parse(await (await upload(app, bytes, key)).json());
    const content = await manager.content(artifact.id);
    if (!published) await manager.delete(artifact.id);
    manager.close();
    const path = await receiptPath(root);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.result.status = "pending"; delete receipt.result.artifact;
    await writeFile(path, JSON.stringify(receipt));
    const restarted = await openManager(root); const resumed = routes(restarted);
    const status = await (await lookup(resumed, key)).json() as any;
    expect(status.status).toBe(published ? "succeeded" : "failed");
    if (published) {
      expect(await (await upload(resumed, bytes, key)).json()).toEqual(artifact);
      expect(await readFile(content!.path)).toEqual(bytes);
    } else {
      await error(await upload(resumed, bytes, key), 409, "image_import_interrupted");
    }
    expect((await restarted.list()).images).toHaveLength(published ? 1 : 0);
  }
});

test("OpenAPI publishes multipart import, UUID lookup, limits, errors and Control bearer", () => {
  const document = createOpenApiDocument("test") as any;
  const operation = document.paths["/v1/image-artifacts/imports"].post;
  expect(operation.security).toEqual([{ bearerAuth: [] }]);
  expect(operation.requestBody.content["multipart/form-data"].schema.required).toEqual(["file"]);
  expect(operation.parameters[0].schema.format).toBe("uuid");
  expect(operation.responses["507"]).toBeDefined(); expect(operation.responses["422"]).toBeDefined();
  expect(operation.description).toContain(String(IMAGE_IMPORT_MAX_BYTES));
  expect(document.paths["/v1/image-imports/{requestId}"].get.parameters[0].in).toBe("path");
});
