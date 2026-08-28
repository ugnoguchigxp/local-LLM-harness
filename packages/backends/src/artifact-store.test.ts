import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactDefinition } from "@larm/core";
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

async function fixture(content = "new-model") {
  const root = await mkdtemp(join(tmpdir(), "larm-artifact-"));
  const target = join(root, "active", "model.gguf");
  const artifact: ArtifactDefinition = {
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
