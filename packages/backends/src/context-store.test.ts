import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalContextMetadataStore, LocalContextSourceStore } from "./context-store";

test("context metadata is saved and loaded atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-metadata-"));
  const store = new LocalContextMetadataStore(root);
  const descriptor = {
    schemaVersion: 1 as const,
    id: "ctx-a",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: "a".repeat(64),
    classification: "internal" as const,
    byteCount: 10,
    tokenCount: 10,
    tokenizerDigest: "b".repeat(64),
    principal: "principal-a",
    state: "active" as const,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
  await store.save([descriptor]);
  expect(await store.load()).toEqual([descriptor]);
});

test("context stores reject symlink roots", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-context-link-"));
  const target = join(parent, "target");
  await new LocalContextMetadataStore(target).initialize();
  const linked = join(parent, "linked");
  await symlink(target, linked);
  await expect(new LocalContextMetadataStore(linked).initialize()).rejects.toMatchObject({
    code: "unsafe_context_root",
  });
});

test("guarded source provisioning fails closed on quota and concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-source-guard-"));
  const store = new LocalContextSourceStore(root);
  const options = {
    maxSourceBytes: 1024,
    maxTotalBytes: 4,
    filesystemFreeFloorBytes: 1,
    tokenizations: [{ tokenizerDigest: "b".repeat(64), tokenCount: 1 }],
  };
  await expect(store.provisionGuarded("principal-a", "too-large", "12345", options))
    .rejects.toMatchObject({ code: "context_source_quota_exceeded" });
  await mkdir(join(root, ".provision.lock"));
  await expect(store.provisionGuarded("principal-a", "busy", "1", {
    ...options,
    maxTotalBytes: 1024,
  })).rejects.toMatchObject({ code: "context_source_provision_busy" });
  await rmdir(join(root, ".provision.lock"));
});

test("local sources are principal scoped and digest verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-sources-"));
  const store = new LocalContextSourceStore(root);
  const tokenizations = [{ tokenizerDigest: "b".repeat(64), tokenCount: 3 }];
  const provisioned = await store.provision("principal-a", "source-a", "trusted context", 1024, tokenizations);
  expect(await store.read(
    "principal-a",
    "source-a",
    provisioned.digest,
    1024,
  )).toEqual({
    content: "trusted context",
    bytes: 15,
    digest: provisioned.digest,
    tokenizations,
  });
  await expect(store.read("principal-b", "source-a", provisioned.digest, 1024))
    .rejects.toMatchObject({ code: "context_source_not_found" });
  await expect(store.read("principal-a", "source-a", "f".repeat(64), 1024))
    .rejects.toMatchObject({ code: "context_source_digest_mismatch" });
});

test("local sources reject symbolic links and oversize files", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-source-unsafe-"));
  const store = new LocalContextSourceStore(root);
  const tokenizations = [{ tokenizerDigest: "b".repeat(64), tokenCount: 1 }];
  await store.provision("principal-a", "seed", "seed", 1024, tokenizations);
  const principalDirectory = join(
    root,
    new Bun.CryptoHasher("sha256").update("principal-a").digest("hex"),
  );
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(principalDirectory, "linked.txt"));
  await expect(store.read("principal-a", "linked", "0".repeat(64), 1024))
    .rejects.toMatchObject({ code: "context_source_unsafe" });
  const large = await store.provision("principal-a", "large", "12345", 1024, tokenizations);
  await expect(store.read("principal-a", "large", large.digest, 4))
    .rejects.toMatchObject({ code: "context_source_too_large" });
  await expect(store.provision("principal-a", "too-large", "12345", 4, tokenizations))
    .rejects.toMatchObject({ code: "context_source_too_large" });
});
