import { mkdir, readFile, rm, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectMeshGlb, meshAssetSchema, meshUrls } from "@larm/core";
import { MeshStore, meshHash } from "./mesh-store";

/** Administrative one-time import of the adopted, hash-pinned trial; no inference. */
export async function importMeshTrial(root: string, trial: string) {
  const store = new MeshStore(resolve(root), { sameDeviceRoots: ["/srv/ai/data/generated/images", "/srv/ai/data/generated/music"] }); await store.initialize();
  const id = "mesh_a745b8c2a29df1559f3dedf9b2968418";
  if (store.get(id)) return store.get(id)!;
  const glb = await readFile(join(trial, "robot-512.glb")), source = await readFile(join(trial, "source-qwen-robot.png"));
  if (meshHash(glb) !== "a745b8c2a29df1559f3dedf9b2968418bf34715ab69d6e9a7fb80d7ab5e555e9" || meshHash(source) !== "042f0ae1953f0a7558b9b4db317c20e2415e4f18545dfae626a1e7bad5ec7246") throw new Error("trial artifact hash mismatch");
  const recorded = JSON.parse(await readFile(join(trial, "robot-512-command.json"), "utf8"));
  const asset = meshAssetSchema.parse({ id, createdAt: new Date(recorded.started.time).toISOString(), title: "青緑のロボット（採用試験）", tags: ["ロボット", "試作", "採用試験"],
    sourceImageId: "image_4a2bb7dad9ee4d5c90823d00fe49ca3f", model: "trellis2-4b", resolution: 512, seed: 42, steps: 12,
    bytes: glb.length, sha256: meshHash(glb), sourceSha256: meshHash(source), sourceMimeType: "image/png", geometry: inspectMeshGlb(glb),
    provenance: { engine: "trellis.cpp v0.8.1 Vulkan", engineCommit: "c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f", weightsRevision: "a57397bd3d351599d9729fc144b3f87c3f87d65b", imported: true },
    warnings: ["Texture is significantly darker than the source image.", "Exact-position welding found 701 duplicate triangles and 5976 non-manifold edges; 7 faces have collapsed UVs. Inspect before editing or printing.", "Embedded WebP textures require EXT_texture_webp support (Blender 4.0+).", "DINOv3 weights have separate license terms."], ...meshUrls(id) });
  const work = join(store.root, "work", `import-${id}`); await mkdir(work, { mode: 0o700 });
  try {
    for (const [name, data] of [["model.glb", glb], ["source.image", source], ["cutout.png", await readFile(join(trial, "background_cutout.png"))]] as const) {
      const f = await open(join(work, name), "wx", 0o600); try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
    }
    return await store.publish(work, asset);
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (import.meta.main) console.log(JSON.stringify(await importMeshTrial(process.argv[2] ?? "/srv/ai/data/generated/3d", process.argv[3] ?? "/srv/ai/results/trellis-trial-20261018")));
