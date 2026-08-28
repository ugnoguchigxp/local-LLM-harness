import { expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalRuntimeReleaseStateStore } from "./release-state-store";

test("runtime release state is saved atomically and loaded strictly", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-release-state-"));
  const store = new LocalRuntimeReleaseStateStore(root);
  await store.save({
    version: 1,
    catalogRevision: "1".repeat(64),
    deployments: [{
      runtime: "qwen-tts",
      activeRelease: "qwen-tts-current",
      previousRelease: null,
      updatedAt: "2026-08-28T00:00:00.000Z",
    }],
  });
  expect(await store.load()).toEqual({
    version: 1,
    catalogRevision: "1".repeat(64),
    deployments: [{
      runtime: "qwen-tts",
      activeRelease: "qwen-tts-current",
      previousRelease: null,
      updatedAt: "2026-08-28T00:00:00.000Z",
    }],
  });
});

test("runtime release state rejects noncanonical revisions and timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-release-state-invalid-"));
  const store = new LocalRuntimeReleaseStateStore(root);
  await expect(store.save({
    version: 1,
    catalogRevision: "not-a-digest",
    deployments: [],
  })).rejects.toMatchObject({ code: "state_corrupt" });
  await expect(store.save({
    version: 1,
    catalogRevision: "2".repeat(64),
    deployments: [{
      runtime: "qwen-tts",
      activeRelease: "qwen-tts-current",
      previousRelease: null,
      updatedAt: "2026-08-28T00:00:00Z",
    }],
  })).rejects.toMatchObject({ code: "state_corrupt" });
});

test("runtime release state rejects symlink roots", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-release-link-"));
  const target = join(parent, "target");
  await new LocalRuntimeReleaseStateStore(target).initialize();
  const linked = join(parent, "linked");
  await symlink(target, linked);
  await expect(new LocalRuntimeReleaseStateStore(linked).initialize()).rejects.toMatchObject({
    code: "unsafe_state_root",
  });
});
