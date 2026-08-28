import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSnapshotDigest,
  type FileArtifactDefinition,
  type SnapshotArtifactDefinition,
} from "@larm/core";
import { ArtifactStoreError, LocalArtifactStore } from "./artifact-store";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("rejects filesystem root as an artifact data directory", () => {
  expect(() => new LocalArtifactStore({
    stagingRoot: "/",
    rollbackRoot: "/tmp/larm-safe-rollback",
    stateRoot: "/tmp/larm-safe-state",
  })).toThrow(/must not be the filesystem root/);
});

test("rejects overlapping artifact data directories", () => {
  expect(() => new LocalArtifactStore({
    stagingRoot: "/tmp/larm-data",
    rollbackRoot: "/tmp/larm-data/rollback",
    stateRoot: "/tmp/larm-state",
  })).toThrow(/must not overlap/);
});

async function fixture(content = "new-model") {
  const root = await mkdtemp(join(tmpdir(), "larm-artifact-"));
  const target = join(root, "active", "model.gguf");
  const artifact: FileArtifactDefinition = {
    kind: "file",
    id: "tiny-model",
    role: "preferred-llm",
    source: "https://example.com/model.gguf",
    revision: "revision-1",
    filename: "model.gguf",
    path: target,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  };
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "staging"),
    rollbackRoot: join(root, "rollback"),
    stateRoot: join(root, "state"),
    random: () => "fixed",
    now: () => 1_000,
    fetchImpl: async () => new Response(content),
  });
  return { root, target, artifact, store };
}

async function snapshotFixture(
  corruptPath?: string,
  options: {
    availableBytes?: number;
    incompleteSnapshotTtlMs?: number;
    fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    contents?: Record<string, string>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "larm-snapshot-"));
  const target = join(root, "active", "model");
  const contents: Record<string, string> = options.contents ?? {
    "config.json": "{}",
    "weights/model.safetensors": "weights",
  };
  const files = Object.entries(contents).map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  }));
  const artifact: SnapshotArtifactDefinition = {
    kind: "snapshot",
    id: "tiny-snapshot",
    role: "preferred-tts",
    source: "https://example.com/model",
    revision: "revision-1",
    path: target,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    maxFiles: files.length,
    snapshotDigest: computeSnapshotDigest(files),
    files,
  };
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "staging"),
    rollbackRoot: join(root, "rollback"),
    stateRoot: join(root, "state"),
    random: () => "fixed",
    now: () => Date.now(),
    availableBytes: options.availableBytes === undefined
      ? undefined
      : () => options.availableBytes!,
    incompleteSnapshotTtlMs: options.incompleteSnapshotTtlMs,
    fetchImpl: options.fetchImpl ?? (async (input) => {
      const path = decodeURIComponent(new URL(input.toString()).pathname)
        .replace(/^\/model\//, "");
      const content = contents[path];
      if (content === undefined) {
        return new Response("missing", { status: 404 });
      }
      return new Response(path === corruptPath ? `${content}-corrupt` : content);
    }),
  });
  return { root, target, artifact, store };
}

test("stages, verifies, activates, and rolls back a checksummed artifact", async () => {
  const { root, target, artifact, store } = await fixture();
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "old-model");
    const staged = await store.stage(artifact);
    expect(await readFile(staged.path, "utf8")).toBe("new-model");
    await store.activate(artifact, staged);
    expect(await readFile(target, "utf8")).toBe("new-model");
    expect(await store.activeMatches(artifact)).toBe(true);
    await store.rollback(artifact);
    expect(await readFile(target, "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a failed download when the checksum does not match", async () => {
  const { root, artifact, store } = await fixture("corrupt");
  artifact.sha256 = sha256("expected");
  try {
    await expect(store.stage(artifact)).rejects.toBeInstanceOf(ArtifactStoreError);
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects and cleans up a download that exceeds the manifest size", async () => {
  const { root, artifact } = await fixture("expected");
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "oversize-staging"),
    rollbackRoot: join(root, "oversize-rollback"),
    stateRoot: join(root, "oversize-state"),
    random: () => "oversize",
    fetchImpl: async () => new Response("expected-extra"),
  });
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "size_mismatch" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a stalled download at its deadline", async () => {
  const { root, artifact } = await fixture();
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "timeout-staging"),
    rollbackRoot: join(root, "timeout-rollback"),
    stateRoot: join(root, "timeout-state"),
    random: () => "timeout",
    downloadTimeoutMs: 5,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      const aborted = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) {
        aborted();
      } else {
        signal.addEventListener("abort", aborted, { once: true });
      }
    }),
  });
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "download_timeout" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a stalled response body even when the stream ignores the fetch signal", async () => {
  const { root, artifact } = await fixture();
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "body-timeout-staging"),
    rollbackRoot: join(root, "body-timeout-rollback"),
    stateRoot: join(root, "body-timeout-state"),
    random: () => "body-timeout",
    downloadTimeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({
      pull: async () => await new Promise<void>(() => undefined),
    })),
  });
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "download_timeout" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller cancellation propagates into an artifact download", async () => {
  const { root, artifact } = await fixture();
  const controller = new AbortController();
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "cancel-staging"),
    rollbackRoot: join(root, "cancel-rollback"),
    stateRoot: join(root, "cancel-state"),
    random: () => "cancel",
    fetchImpl: async () => await new Promise<Response>(() => undefined),
  });
  try {
    const staging = store.stage(artifact, controller.signal);
    controller.abort(new Error("allocation released"));
    await expect(staging).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation rejects a forged staged path", async () => {
  const { root, target, artifact, store } = await fixture();
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "new-model");
    const staged = await store.stage(artifact);
    await expect(store.activate(artifact, { ...staged, path: target })).rejects.toMatchObject({
      code: "artifact_mismatch",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects an unsafe revision even for programmatic callers", async () => {
  const { root, artifact, store } = await fixture();
  artifact.revision = "../../escape";
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "unsafe_path" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects artifact targets that overlap managed data roots", async () => {
  const { root, artifact, store } = await fixture();
  artifact.path = join(root, "staging");
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "unsafe_path" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback restores an absent target by removing the activated link", async () => {
  const { root, target, artifact, store } = await fixture();
  try {
    const staged = await store.stage(artifact);
    await store.activate(artifact, staged);
    expect(await Bun.file(target).exists()).toBe(true);
    await store.rollback(artifact);
    expect(await Bun.file(target).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback preflight rejects artifacts without an activation record", async () => {
  const { root, artifact, store } = await fixture();
  try {
    await expect(store.requireRollback(artifact)).rejects.toMatchObject({
      code: "rollback_unavailable",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists operation journal records outside the repository", async () => {
  const { root, store } = await fixture();
  try {
    await store.writeOperation({ id: "artifact_op_1", status: "running", kind: "stage" });
    expect(await store.loadOperations()).toEqual([
      { id: "artifact_op_1", status: "running", kind: "stage" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation journal rejects unsafe identifiers", async () => {
  const { root, store } = await fixture();
  try {
    await expect(store.writeOperation({ id: "../escape", status: "running" })).rejects
      .toMatchObject({ code: "unsafe_operation_id" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages, activates, and rolls back an exact directory snapshot", async () => {
  const { root, target, artifact, store } = await snapshotFixture();
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old-model");
    const staged = await store.stage(artifact);
    expect(staged.kind).toBe("snapshot");
    expect(await readFile(join(staged.path, "weights/model.safetensors"), "utf8")).toBe("weights");
    await store.activate(artifact, staged);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "config.json"), "utf8")).toBe("{}");
    expect(await store.activeMatches(artifact)).toBe(true);
    await store.rollback(artifact);
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot verification uses canonical global path order", async () => {
  const { root, artifact, store } = await snapshotFixture(undefined, {
    contents: {
      "a.txt": "root-file",
      "a/file.bin": "nested-file",
    },
  });
  try {
    const staged = await store.stage(artifact);
    expect(await store.getStaged(artifact)).toEqual(staged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans an incomplete snapshot after a file checksum failure", async () => {
  const { root, artifact, store } = await snapshotFixture("weights/model.safetensors");
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "size_mismatch" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links injected into a staged snapshot", async () => {
  const { root, artifact, store } = await snapshotFixture();
  try {
    const staged = await store.stage(artifact);
    const injected = join(staged.path, "weights/model.safetensors");
    await rm(injected);
    await symlink("/etc/passwd", injected);
    await expect(store.activate(artifact, staged)).rejects.toMatchObject({ code: "unsafe_snapshot" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not accept unlisted files in a staged snapshot", async () => {
  const { root, artifact, store } = await snapshotFixture();
  try {
    const staged = await store.stage(artifact);
    await writeFile(join(staged.path, "unlisted.txt"), "unexpected");
    expect(await store.getStaged(artifact)).toBeUndefined();
    await expect(store.activate(artifact, staged)).rejects.toMatchObject({ code: "staged_invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not accept unlisted empty directories in a staged snapshot", async () => {
  const { root, artifact, store } = await snapshotFixture();
  try {
    const staged = await store.stage(artifact);
    await mkdir(join(staged.path, "empty"));
    expect(await store.getStaged(artifact)).toBeUndefined();
    await expect(store.activate(artifact, staged)).rejects.toMatchObject({ code: "staged_invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a snapshot before download when disk reserve is insufficient", async () => {
  const { root, artifact, store } = await snapshotFixture(undefined, { availableBytes: 1 });
  try {
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "disk_space_exhausted" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels and removes a partially downloaded snapshot", async () => {
  const controller = new AbortController();
  const { root, artifact, store } = await snapshotFixture(undefined, {
    fetchImpl: async (input, init) => {
      if (input.toString().endsWith("config.json")) {
        return new Response("{}");
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  try {
    const staging = store.stage(artifact, controller.signal);
    await Bun.sleep(1);
    controller.abort(new Error("daemon draining"));
    await expect(staging).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(await store.getStaged(artifact)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans expired partial snapshot directories after restart", async () => {
  const { root, artifact, store } = await snapshotFixture(undefined, {
    incompleteSnapshotTtlMs: 1,
  });
  try {
    const stagingParent = join(root, "staging", artifact.id, artifact.revision);
    const stale = join(stagingParent, `${artifact.snapshotDigest}.part-stale`);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "partial"), "partial");
    await utimes(stale, new Date(0), new Date(0));
    await store.stage(artifact);
    expect(await Bun.file(join(stale, "partial")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback recovers a directory displaced by a crash during prepared activation", async () => {
  const { root, target, artifact, store } = await snapshotFixture();
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old-model");
    const staged = await store.stage(artifact);
    const previous = join(root, "rollback", artifact.id, "crash-previous");
    await mkdir(join(root, "rollback", artifact.id), { recursive: true });
    await rename(target, previous);
    await mkdir(join(root, "state", "activations"), { recursive: true });
    await writeFile(join(root, "state", "activations", `${artifact.id}.json`), `${JSON.stringify({
      artifactKind: artifact.kind,
      artifactDigest: artifact.snapshotDigest,
      phase: "prepared",
      artifactId: artifact.id,
      revision: artifact.revision,
      target,
      activePath: staged.path,
      previous: { kind: "directory", path: previous },
      activatedAt: new Date().toISOString(),
    })}\n`);

    await store.rollback(artifact);
    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old-model");
    // A crash before displacement is also safe: the original target exists and backup does not.
    await store.rollback(artifact);
    expect(await readFile(join(target, "old.txt"), "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restaging never replaces a corrupt snapshot while it is the active target", async () => {
  const { root, target, artifact, store } = await snapshotFixture();
  try {
    const staged = await store.stage(artifact);
    await store.activate(artifact, staged);
    await writeFile(join(staged.path, "unlisted.txt"), "unexpected");
    await expect(store.stage(artifact)).rejects.toMatchObject({ code: "active_artifact_invalid" });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(target, "config.json"), "utf8")).toBe("{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
