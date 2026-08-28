import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalRuntimeReleaseStateStore,
  type RuntimeReleaseState,
} from "@larm/backends";
import type { RuntimeReleaseDefinition } from "@larm/core";
import type { ArtifactManager, ArtifactOperation } from "./artifact-manager";
import { RuntimeReleaseManager, RuntimeReleaseManagerError } from "./runtime-release-manager";

const releases: RuntimeReleaseDefinition[] = [
  {
    id: "qwen-tts-r1",
    runtime: "qwen-tts",
    artifacts: ["tts-r1"],
    providerConfigRevision: "config-r1",
    estimatedMemoryGB: 5,
    healthPath: "/health",
    default: true,
    digest: "1".repeat(64),
  },
  {
    id: "qwen-tts-r2",
    runtime: "qwen-tts",
    artifacts: ["tts-r2"],
    providerConfigRevision: "config-r2",
    estimatedMemoryGB: 5,
    healthPath: "/health",
    default: false,
    digest: "2".repeat(64),
  },
];

function operation(kind: ArtifactOperation["kind"], releaseId: string): ArtifactOperation {
  return {
    id: `artifact_op_${kind}`,
    kind,
    runtimeId: "qwen-tts",
    releaseId,
    status: "succeeded",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

async function fixture(options: {
  saved?: RuntimeReleaseState;
  active?: (artifactIds: string[]) => boolean;
  activationStatus?: ArtifactOperation["status"];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "larm-release-manager-"));
  const store = new LocalRuntimeReleaseStateStore(root);
  const callbacks: (() => Promise<void>)[] = [];
  const fake = {
    areArtifactsActive: async (artifactIds: string[]) => options.active?.(artifactIds) ?? true,
    stageRelease: async (releaseId: string) => operation("stage", releaseId),
    planRuntimeActivation: async () => [],
    inspectStagedArtifacts: async () => ({ staged: false, additionalBytesRequired: 123 }),
    activateRuntimeRelease: async (
      _runtimeId: string,
      releaseId: string,
      _artifactIds: string[],
      _providerConfigRevision: string,
      _healthPath: string,
      callback: () => Promise<void>,
    ) => {
      callbacks.push(callback);
      await callback();
      return { ...operation("activate", releaseId), status: options.activationStatus ?? "succeeded" };
    },
    rollbackRuntimeRelease: async (
      _runtimeId: string,
      releaseId: string,
      _artifactIds: string[],
      _providerConfigRevision: string,
      _healthPath: string,
      callback: () => Promise<void>,
    ) => {
      await callback();
      return operation("rollback", releaseId);
    },
    flush: async () => undefined,
    hasActiveOperations: () => false,
    findLatestOperation: ({ kind, releaseId }: { kind: string; releaseId?: string }) =>
      kind === "activate" && releaseId === "qwen-tts-r2"
        ? operation("activate", "qwen-tts-r2")
        : undefined,
  } as unknown as ArtifactManager;
  if (options.saved) await store.save(options.saved);
  const manager = new RuntimeReleaseManager(releases, fake, store, () => Date.parse("2026-08-28T00:00:00Z"));
  await manager.initialize();
  return { manager, store, callbacks };
}

test("runtime release manager selects the declared default without hashing model data at startup", async () => {
  const { manager, store } = await fixture();
  expect(manager.getDeployment("qwen-tts").activeRelease).toBe("qwen-tts-r1");
  expect(await manager.plan("qwen-tts", "qwen-tts-r2")).toMatchObject({
    providerConfigRevision: "config-r2",
    healthPath: "/health",
    requiresStop: false,
    staged: false,
    rollbackAvailable: true,
    disk: { additionalBytesRequired: 123, checkedDuringStage: false },
  });
  const op = await manager.activate("qwen-tts", "qwen-tts-r2", "qwen-tts-r1");
  expect(op.releaseId).toBe("qwen-tts-r2");
  expect(manager.getDeployment("qwen-tts")).toMatchObject({
    activeRelease: "qwen-tts-r2",
    previousRelease: "qwen-tts-r1",
    activeProviderConfigRevision: "config-r2",
    previousProviderConfigRevision: "config-r1",
  });
  expect(manager.listPublicReleases()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "qwen-tts-r2", state: "active" }),
    expect.objectContaining({ id: "qwen-tts-r1", state: "previous" }),
  ]));
  expect((await store.load())?.deployments[0]?.activeRelease).toBe("qwen-tts-r2");
});

test("runtime release manager recovers a crash-persisted prepared activation", async () => {
  const { manager, store } = await fixture({
    active: (artifactIds) => artifactIds.includes("tts-r2"),
    saved: {
      version: 1,
      catalogRevision: "0".repeat(64),
      deployments: [{
        runtime: "qwen-tts",
        activeRelease: "qwen-tts-r1",
        previousRelease: null,
        updatedAt: "2026-08-28T00:00:00.000Z",
        pending: {
          kind: "activate",
          targetRelease: "qwen-tts-r2",
          originalActiveRelease: "qwen-tts-r1",
          originalPreviousRelease: null,
          startedAt: "2026-08-28T00:00:01.000Z",
        },
      }],
    },
  });
  expect(manager.getDeployment("qwen-tts")).toMatchObject({
    activeRelease: "qwen-tts-r2",
    previousRelease: "qwen-tts-r1",
    pendingRelease: undefined,
  });
  expect((await store.load())?.deployments[0]?.pending).toBeUndefined();
});

test("runtime release recovery rejects a mixed or unverifiable artifact generation", async () => {
  await expect(fixture({
    active: () => false,
    saved: {
      version: 1,
      catalogRevision: "0".repeat(64),
      deployments: [{
        runtime: "qwen-tts",
        activeRelease: "qwen-tts-r1",
        previousRelease: null,
        updatedAt: "2026-08-28T00:00:00.000Z",
        pending: {
          kind: "activate",
          targetRelease: "qwen-tts-r2",
          originalActiveRelease: "qwen-tts-r1",
          originalPreviousRelease: null,
          startedAt: "2026-08-28T00:00:01.000Z",
        },
      }],
    },
  })).rejects.toMatchObject({ code: "state_corrupt" });
});

test("runtime release recovery restores the original pointer only after verifying its artifacts", async () => {
  const { manager, store } = await fixture({
    active: (artifactIds) => artifactIds.includes("tts-r1"),
    saved: {
      version: 1,
      catalogRevision: "0".repeat(64),
      deployments: [{
        runtime: "qwen-tts",
        activeRelease: "qwen-tts-r1",
        previousRelease: null,
        updatedAt: "2026-08-28T00:00:00.000Z",
        pending: {
          kind: "activate",
          targetRelease: "qwen-tts-r2",
          originalActiveRelease: "qwen-tts-r1",
          originalPreviousRelease: null,
          startedAt: "2026-08-28T00:00:01.000Z",
        },
      }],
    },
  });
  expect(manager.getDeployment("qwen-tts").activeRelease).toBe("qwen-tts-r1");
  expect((await store.load())?.deployments[0]?.pending).toBeUndefined();
});

test("runtime release manager enforces optimistic concurrency and rollback", async () => {
  const { manager } = await fixture();
  await expect(manager.activate("qwen-tts", "qwen-tts-r2", null)).rejects.toBeInstanceOf(
    RuntimeReleaseManagerError,
  );
  await manager.activate("qwen-tts", "qwen-tts-r2", "qwen-tts-r1");
  await manager.rollback("qwen-tts");
  expect(manager.getDeployment("qwen-tts")).toMatchObject({
    activeRelease: "qwen-tts-r1",
    previousRelease: null,
  });
});

test("terminal journal failure converges the release pointer to verified target artifacts", async () => {
  const { manager, store } = await fixture({
    activationStatus: "failed",
    active: (artifactIds) => artifactIds.includes("tts-r2"),
  });
  const operation = await manager.activate("qwen-tts", "qwen-tts-r2", "qwen-tts-r1");
  expect(operation.status).toBe("failed");
  expect(manager.getDeployment("qwen-tts")).toMatchObject({
    activeRelease: "qwen-tts-r2",
    previousRelease: "qwen-tts-r1",
  });
  const saved = (await store.load())?.deployments[0];
  expect(saved).toMatchObject({
    activeRelease: "qwen-tts-r2",
    previousRelease: "qwen-tts-r1",
  });
  expect(saved && "pending" in saved).toBeFalse();
});

test("retrying an already active immutable release converges to the prior operation", async () => {
  const { manager } = await fixture();
  const first = await manager.activate("qwen-tts", "qwen-tts-r2", "qwen-tts-r1");
  const retried = await manager.activate("qwen-tts", "qwen-tts-r2", "qwen-tts-r1");
  expect(retried.id).toBe(first.id);
  expect(manager.getDeployment("qwen-tts").activeRelease).toBe("qwen-tts-r2");
});

test("runtime release manager rejects mutation of an active immutable release", async () => {
  const { manager } = await fixture();
  await expect(manager.replaceCatalog([{ ...releases[0]!, digest: "f".repeat(64) }, releases[1]!]))
    .rejects.toMatchObject({ code: "catalog_conflict" });
});

test("runtime release manager rejects mutation of an inactive immutable release", async () => {
  const { manager } = await fixture();
  await expect(manager.replaceCatalog([releases[0]!, { ...releases[1]!, digest: "e".repeat(64) }]))
    .rejects.toMatchObject({ code: "catalog_conflict" });
});
