import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, lstat, realpath, statfs } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { meshIdSchema, meshJobIdSchema, meshAssetSchema, meshUrls, meshAssetPatchSchema, listMeshAssets, type MeshAsset, type MeshQuery } from "@larm/core";

export class MeshError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 429 | 503 | 507, message: string) { super(message); }
}
export const meshHash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export async function durableJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path); await syncDirectory(resolve(path, ".."));
}
export async function syncDirectory(path: string) {
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
export async function safeFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const base = await realpath(root), canonical = await realpath(path);
  if (!canonical.startsWith(base + sep) || canonical !== resolve(path)) throw new MeshError("unsafe_path", 400, "unsafe artifact path");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new MeshError("invalid_file", 400, "invalid artifact size or type");
  const handle = await open(path, "r");
  try { const after = await handle.stat(); if (after.ino !== info.ino || after.dev !== info.dev) throw new Error("file changed"); return await handle.readFile(); }
  finally { await handle.close(); }
}
export class MeshStore {
  readonly deletedIds = new Set<string>();
  readonly deletedJobs = new Set<string>();
  readonly assets = new Map<string, { asset: MeshAsset; directory: string; bytes: number }>();
  readonly root: string;
  ready = false;
  private tail = Promise.resolve();
  constructor(root: string, readonly options: { maxBytes?: number; freeFloorBytes?: number; workBytes?: number; sameDeviceRoots?: string[] } = {}) { this.root = resolve(root); }
  serialized<T>(fn: () => Promise<T>): Promise<T> { const p = this.tail.then(fn); this.tail = p.then(() => {}, () => {}); return p; }
  async initialize() {
    if (await realpath(this.root) !== this.root) throw new MeshError("storage_unavailable", 503, "3D storage must be a real directory");
    for (const name of ["assets", "jobs", "work", ".trash"]) {
      await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
      if (await realpath(join(this.root, name)) !== join(this.root, name)) throw new Error("unsafe storage directory");
    }
    const probe = join(this.root, `.probe-${randomUUID()}`); const file = await open(probe, "wx", 0o600); await file.close(); await rm(probe);
    const device = (await lstat(this.root)).dev;
    for (const root of this.options.sameDeviceRoots ?? []) {
      const other = await realpath(root);
      if (other === this.root || other.startsWith(this.root + sep) || this.root.startsWith(other + sep)) throw new MeshError("storage_unavailable", 503, "media storage roots must not overlap");
      if ((await lstat(other)).dev !== device) throw new MeshError("storage_unavailable", 503, "3D, image and music storage must use the same filesystem");
    }
    for (const item of await readdir(join(this.root, "jobs"))) {
      if (!/^deleted-mesh_[a-f0-9]{32}\.json$/.test(item)) continue;
      const marker = JSON.parse((await safeFile(this.root, join(this.root, "jobs", item), 1024)).toString());
      const id = meshIdSchema.parse(marker.id);
      if (item !== `deleted-${id}.json`) throw new Error("invalid deletion marker");
      this.deletedIds.add(id); if (marker.jobId) this.deletedJobs.add(meshJobIdSchema.parse(marker.jobId));
    }
    for (const item of await readdir(join(this.root, ".trash"))) await rm(join(this.root, ".trash", item), { recursive: true, force: true });
    const scan = async (dir: string, depth: number) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (depth < 2) { if (/^\d{2,4}$/.test(entry.name)) await scan(path, depth + 1); continue; }
        if (!/^mesh_[a-f0-9]{32}$/.test(entry.name)) continue;
        if (this.deletedIds.has(entry.name)) { await rm(path, { recursive: true, force: true }); continue; }
        try {
          const asset = meshAssetSchema.parse(JSON.parse((await safeFile(this.root, join(path, "metadata.json"), 128 * 1024)).toString()));
          if (asset.id !== entry.name) continue;
          const bytes = await this.directoryBytes(path);
          this.assets.set(asset.id, { asset, directory: path, bytes });
        } catch { console.warn("ignored invalid 3D asset metadata"); }
      }
    };
    await scan(join(this.root, "assets"), 0);
    this.ready = true;
  }
  async directoryBytes(path: string): Promise<number> {
    let total = 0;
    for (const e of await readdir(path, { withFileTypes: true })) {
      const st = await lstat(join(path, e.name));
      if (!e.isFile() || e.isSymbolicLink()) throw new Error("unexpected asset entry");
      total += st.size;
    }
    return total;
  }
  async capacity(reservedBytes = 0) {
    const used = [...this.assets.values()].reduce((a, b) => a + b.bytes, 0);
    if (used + reservedBytes > (this.options.maxBytes ?? 50 * 1024 ** 3)) throw new MeshError("storage_full", 507, "3D library quota exceeded; explicitly delete unwanted assets");
    const fs = await statfs(this.root);
    if (fs.bavail * fs.bsize < (this.options.freeFloorBytes ?? 32 * 1024 ** 3) + (this.options.workBytes ?? 20 * 1024 ** 3) + reservedBytes) throw new MeshError("storage_full", 507, "insufficient free disk space");
  }
  get(id: string) { return this.assets.get(id)?.asset; }
  list(query: MeshQuery) { return listMeshAssets([...this.assets.values()].map((v) => v.asset), query); }
  async content(id: string, kind: "content" | "source") {
    return this.serialized(async () => {
      const item = this.assets.get(id); if (!item) return undefined;
      const data = await safeFile(this.root, join(item.directory, kind === "content" ? "model.glb" : "source.image"), kind === "content" ? 256 * 1024 ** 2 : 20 * 1024 ** 2).catch(() => { throw new MeshError("artifact_unavailable", 503, "saved artifact is unavailable"); });
      const hash = kind === "content" ? item.asset.sha256 : item.asset.sourceSha256;
      if (meshHash(data) !== hash) throw new MeshError("artifact_corrupt", 503, "saved artifact failed integrity check");
      return { data, hash, mimeType: kind === "content" ? "model/gltf-binary" : item.asset.sourceMimeType };
    });
  }
  async publish(work: string, asset: MeshAsset) {
    return this.serialized(async () => {
      asset = meshAssetSchema.parse({ ...asset, ...meshUrls(asset.id) });
      if (this.deletedIds.has(asset.id)) throw new MeshError("asset_deleted", 409, "asset was explicitly deleted");
      const dir = join(this.root, "assets", asset.createdAt.slice(0, 4), asset.createdAt.slice(5, 7));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (await realpath(dir) !== dir) throw new Error("unsafe asset directory");
      const sizes = await Promise.all(["model.glb", "source.image", "cutout.png"].map(async (n) => (await lstat(join(work, n))).size));
      await this.capacity(sizes.reduce((a, b) => a + b, 128 * 1024));
      await durableJson(join(work, "metadata.json"), asset);
      // Only validated asset files are retained. Logs and process scratch stay in work.
      const stage = join(this.root, "work", `publish-${asset.id}`);
      await mkdir(stage, { mode: 0o700 });
      for (const name of ["model.glb", "source.image", "cutout.png", "metadata.json"]) {
        const data = await safeFile(this.root, join(work, name), name === "model.glb" ? 256 * 1024 ** 2 : 20 * 1024 ** 2);
        const f = await open(join(stage, name), "wx", 0o600); try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
      }
      await syncDirectory(stage); const target = join(dir, asset.id); await rename(stage, target); await syncDirectory(dir);
      this.assets.set(asset.id, { asset, directory: target, bytes: await this.directoryBytes(target) });
      return asset;
    });
  }
  async patch(id: string, value: unknown) {
    return this.serialized(async () => {
      const item = this.assets.get(id); if (!item) return undefined;
      const patch = meshAssetPatchSchema.parse(value);
      const asset = meshAssetSchema.parse({ ...item.asset, ...patch });
      await durableJson(join(item.directory, "metadata.json"), asset); item.asset = asset; item.bytes = await this.directoryBytes(item.directory);
      return asset;
    });
  }
  async remove(id: string, redact: () => Promise<void>) {
    return this.serialized(async () => {
      const item = this.assets.get(id); if (!item) return false;
      const trash = join(this.root, ".trash", id);
      // Keep a minimal durable intent even if the daemon crashes before its job journal is redacted.
      const marker = join(this.root, "jobs", `deleted-${id}.json`);
      await durableJson(marker, { id, ...(item.asset.jobId ? { jobId: item.asset.jobId } : {}) });
      this.deletedIds.add(id); if (item.asset.jobId) this.deletedJobs.add(item.asset.jobId);
      await rename(item.directory, trash); await syncDirectory(resolve(item.directory, ".."));
      this.assets.delete(id);
      await redact(); // A crash here is reconciled from missing assets on startup.
      await rm(trash, { recursive: true, force: true }); await syncDirectory(join(this.root, ".trash"));
      return true;
    });
  }
}
