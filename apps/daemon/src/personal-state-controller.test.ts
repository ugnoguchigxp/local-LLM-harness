import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalContextSourceStore,
  LocalPersonalStateJournal,
  type LlamaContextSlotEraseAdapter,
  type LlamaContextTokenizer,
} from "@larm/backends";
import { personalStateSubjectDigest, type ContextDescriptor } from "@larm/core";
import { ContextController } from "./context-controller";
import { PersonalStateController } from "./personal-state-controller";

const tokenizerDigest = "b".repeat(64);
const chatTemplateDigest = "c".repeat(64);
const sourceDigest = new Bun.CryptoHasher("sha256").update("personal source").digest("hex");

function contextFixture(onSelected: (count: number) => void) {
  const publicView = {
    id: "view_product",
    operationId: "ctxop_product",
    allocationId: "alloc_product",
    runtime: "qwen-general",
    release: "release-current",
    state: "ready" as const,
    mode: "source-rebuild" as const,
    canonicalizationVersion: "context-view-v2" as const,
    requestDigest: "d".repeat(64),
    dataEpoch: 0,
    tokenCount: 16,
    inputBudgetTokens: 32,
    orderedItems: [],
    omitted: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2026-09-13T00:10:00.000Z",
  };
  return {
    productRuntimeBinding: () => ({
      endpoint: "http://127.0.0.1:8080",
      release: "release-current",
      leaseEpoch: 2,
      tokenizerDigest,
      chatTemplateDigest,
      contextLimitTokens: 64,
      outputReserveTokens: 8,
      safetyMarginTokens: 2,
      sourceTokenLimit: 128,
      leaseExpiresAt: "2026-09-13T00:05:00.000Z",
      materializedMaxBytes: 4096,
      operationTimeoutMs: 60_000,
      filesystemFreeFloorBytes: 0,
    }),
    personalStateCleanupEndpoint: () => "http://127.0.0.1:8080",
    measureCanonicalRequest: async (input: { items?: unknown[] }) => ({
      inputTokens: 10 + (input.items?.length ?? 0) * 6,
      inputBudgetTokens: 32,
      release: "release-current",
      leaseEpoch: 2,
      tokenizerDigest,
      chatTemplateDigest,
      sourceDigests: (input.items ?? []).map(() => sourceDigest),
    }),
    createView: async (request: { items: unknown[] }) => {
      onSelected(request.items.length);
      return { view: publicView, replay: false };
    },
    register: async (request: Record<string, unknown>) => ({
      replay: false,
      descriptor: {
        schemaVersion: 1,
        ...request,
        state: "active",
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    }),
    bindPersonalStateView: async (input: {
      selectedItems: Array<{ contextId: string; version: string; required: boolean; utility: number }>;
    }) => ({
      ...publicView,
      orderedItems: input.selectedItems.map((item) => ({
        ...item,
        tokenCount: 3,
        sourceDigest,
      })),
    }),
    getView: () => publicView,
    viewPersonalStateBinding: () => ({
      requestDigest: "d".repeat(64),
      dataEpoch: 0,
      sourceDigests: [sourceDigest],
    }),
    invalidatePersonalState: async (): Promise<{
      descriptors: ContextDescriptor[];
      viewIds: string[];
      sourceDigests: string[];
    }> => ({ descriptors: [], viewIds: ["view_product"], sourceDigests: [sourceDigest] }),
  } as unknown as ContextController;
}

test("Personal State provision, exact measurement, attempt cancellation, and gate-off forget are durable", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-personal-controller-"));
  try {
    const journal = new LocalPersonalStateJournal(join(parent, "journal"));
    const sourceStore = new LocalContextSourceStore(join(parent, "sources"));
    let selected = 0;
    const quarantined: string[] = [];
    const cleared: string[] = [];
    const context = contextFixture((count) => {
      selected = count;
    });
    const common = {
      journal,
      context,
      sourceStore,
      tokenizer: { countSourceTokens: async () => 3 } as unknown as LlamaContextTokenizer,
      slotAdapter: { erase: async () => undefined } as LlamaContextSlotEraseAdapter,
      sourceMaxBytes: 1024,
      sourceMaxTotalBytes: 4096,
      receiptTtlMs: 24 * 60 * 60 * 1000,
      quarantineRuntime: (runtime: string) => quarantined.push(runtime),
      clearRuntimeQuarantine: (runtime: string) => cleared.push(runtime),
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
    };
    const controller = new PersonalStateController({ enabled: true, ...common });
    await controller.initialize();
    await expect(controller.provision({
      principal: "principal-a",
      incarnation: "empty",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      sourceDigest: new Bun.CryptoHasher("sha256").update("").digest("hex"),
      content: "",
    })).rejects.toMatchObject({ status: 400, code: "personal_state_request_invalid" });
    const zeroTokenController = new PersonalStateController({
      enabled: true,
      ...common,
      tokenizer: { countSourceTokens: async () => 0 } as unknown as LlamaContextTokenizer,
    });
    const zeroTokenContent = "untokenized source";
    await expect(zeroTokenController.provision({
      principal: "principal-a",
      incarnation: "zero-token",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      sourceDigest: new Bun.CryptoHasher("sha256").update(zeroTokenContent).digest("hex"),
      content: zeroTokenContent,
    })).rejects.toMatchObject({ status: 422, code: "personal_state_request_invalid" });
    const provision = await controller.provision({
      principal: "principal-a",
      incarnation: "inc-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      sourceDigest,
      content: "personal source",
    });
    expect(provision.receipt).toMatchObject({ state: "succeeded", tokenCount: 3, dataEpoch: 0 });
    expect((await controller.provision({
      principal: "principal-a",
      incarnation: "inc-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      sourceDigest,
      content: "personal source",
    })).replay).toBe(true);
    const registered = await controller.registerContext({
      principal: "principal-a",
      allocationId: "alloc_product",
      idempotencyKey: "register-key",
      request: {
        id: "ctx-required",
        version: "v1",
        sourceHandle: provision.receipt.sourceHandle,
        sourceDigest,
        classification: "restricted",
        byteCount: provision.receipt.byteCount,
        tokenCount: provision.receipt.tokenCount,
        tokenizerDigest,
      },
    });
    expect(registered.descriptor).toMatchObject({ id: "ctx-required", sourceDigest });
    await expect(controller.registerContext({
      principal: "principal-b",
      allocationId: "alloc_product",
      idempotencyKey: "register-key",
      request: {
        id: "ctx-required",
        version: "v1",
        sourceHandle: provision.receipt.sourceHandle,
        sourceDigest,
        classification: "restricted",
        byteCount: provision.receipt.byteCount,
        tokenCount: provision.receipt.tokenCount,
        tokenizerDigest,
      },
    })).rejects.toMatchObject({ code: "personal_state_not_found" });

    const request = { model: "qwen", messages: [{ role: "user", content: "hello" }] };
    const measured = await controller.measure("principal-a", {
      measurementId: "measure-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      maxInputTokens: 32,
      request,
    });
    expect(measured.receipt).toMatchObject({ baseInputTokens: 10, maxInputTokens: 32 });
    const viewRequest = {
      viewRequestId: "view-request-1",
      measurementId: "measure-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      maxInputTokens: 20,
      deadline: "2026-09-13T00:01:00.000Z",
      canonicalizationVersion: "context-view-v2" as const,
      request,
      items: [
        { contextId: "ctx-required", version: "v1", required: true, utility: 1 },
        { contextId: "ctx-optional", version: "v1", required: false, utility: 0.5 },
      ],
    };
    await controller.createView("principal-a", viewRequest, "view-key");
    expect(selected).toBe(1);
    expect((await controller.createView("principal-a", viewRequest, "view-key")).replay).toBe(true);
    await expect(controller.createView("principal-a", viewRequest, "another-key"))
      .rejects.toMatchObject({ code: "request_digest_mismatch" });
    expect(await controller.viewReceipt("principal-a", "view-request-1"))
      .toMatchObject({
        viewId: "view_product",
        state: "ready",
        dependencies: { contextIds: ["ctx-required"], sourceDigests: [sourceDigest] },
      });

    const begunAttempt = await controller.beginAttempt({
      principal: "principal-a",
      attemptId: "attempt-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      release: "release-current",
      request,
    });
    expect(begunAttempt.attempt.state).toBe("accepted");
    await controller.markAttemptForwarded(begunAttempt.attempt.subjectDigest, "attempt-1");
    expect((await controller.cancelAttempt("principal-a", "attempt-1")).stopState)
      .toBe("backend_stopped");
    await controller.finishAttempt({
      subjectDigest: begunAttempt.attempt.subjectDigest,
      attemptId: "attempt-1",
      succeeded: false,
      cancelled: true,
      transportClosed: true,
      outcome: "attempt_cancelled",
    });
    expect(await controller.attemptReceipt("principal-a", "attempt-1"))
      .toMatchObject({ state: "cancelled", stopState: "backend_stopped" });

    const uncertain = new PersonalStateController({
      enabled: true,
      ...common,
      slotAdapter: { erase: async () => { throw new Error("backend unavailable"); } },
    });
    await uncertain.initialize();
    await uncertain.beginAttempt({
      principal: "principal-a",
      attemptId: "attempt-unknown",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      release: "release-current",
      request,
    });
    expect(await uncertain.cancelAttempt("principal-a", "attempt-unknown"))
      .toMatchObject({ state: "cancelled", stopState: "stop_unknown" });
    expect(quarantined).toContain("qwen-general");
    quarantined.length = 0;
    const recovered = new PersonalStateController({ enabled: true, ...common });
    await recovered.initialize();
    expect(quarantined).toEqual(["qwen-general"]);
    expect(await controller.cancelAttempt("principal-a", "attempt-unknown"))
      .toMatchObject({ state: "cancelled", stopState: "backend_stopped" });
    expect(cleared).toContain("qwen-general");
    const transportAttempt = await controller.beginAttempt({
      principal: "principal-a",
      attemptId: "attempt-transport",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      release: "release-current",
      request,
    });
    await controller.finishAttempt({
      subjectDigest: transportAttempt.attempt.subjectDigest,
      attemptId: "attempt-transport",
      succeeded: false,
      cancelled: true,
      transportClosed: true,
      outcome: "client_cancelled",
    });
    expect(await controller.attemptReceipt("principal-a", "attempt-transport"))
      .toMatchObject({ state: "cancelled", stopState: "backend_stopped", outcome: "client_cancelled" });

    const disconnectedAttempt = await controller.beginAttempt({
      principal: "principal-a",
      attemptId: "attempt-disconnected",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      release: "release-current",
      request,
    });
    await controller.markAttemptForwarded(disconnectedAttempt.attempt.subjectDigest, "attempt-disconnected");
    await controller.finishAttempt({
      subjectDigest: disconnectedAttempt.attempt.subjectDigest,
      attemptId: "attempt-disconnected",
      succeeded: false,
      cancelled: false,
      transportClosed: true,
      outcome: "upstream_error",
    });
    expect(await controller.attemptReceipt("principal-a", "attempt-disconnected"))
      .toMatchObject({ state: "failed", stopState: "backend_stopped", outcome: "upstream_error" });

    const cleanup = new PersonalStateController({ enabled: false, ...common });
    await cleanup.initialize();
    const forgotten = await cleanup.forget("principal-a", {
      forgetId: "forget-1",
      incarnation: "inc-1",
      contextIds: ["ctx-required"],
      sourceHandles: [],
      attemptIds: ["attempt-1"],
    });
    expect(forgotten.operation).toMatchObject({ state: "succeeded", absenceVerified: true, fenceEpoch: 1 });
    expect(await sourceStore.absent("principal-a", provision.receipt.sourceHandle)).toBe(true);
    await expect(controller.provision({
      principal: "principal-a",
      incarnation: "inc-1",
      allocationId: "alloc_product",
      runtime: "qwen-general",
      sourceDigest,
      content: "personal source",
    })).rejects.toMatchObject({ code: "forget_in_progress" });
    await expect(controller.registerContext({
      principal: "principal-a",
      allocationId: "alloc_product",
      idempotencyKey: "register-after-forget",
      request: {
        id: "ctx-required",
        version: "v1",
        sourceHandle: provision.receipt.sourceHandle,
        sourceDigest,
        classification: "restricted",
        byteCount: provision.receipt.byteCount,
        tokenCount: provision.receipt.tokenCount,
        tokenizerDigest,
      },
    })).rejects.toMatchObject({ code: "forget_in_progress" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("forget retry reuses the dependency plan persisted before destructive invalidation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-personal-forget-retry-"));
  try {
    const journal = new LocalPersonalStateJournal(join(parent, "journal"));
    let invalidations = 0;
    let sourceDeletes = 0;
    const descriptor: ContextDescriptor = {
      schemaVersion: 1,
      id: "context-retry",
      version: "v1",
      sourceHandle: "source-retry",
      sourceDigest: "e".repeat(64),
      classification: "restricted",
      byteCount: 10,
      tokenCount: 2,
      tokenizerDigest,
      principal: "principal-retry",
      state: "active",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    const context = {
      invalidatePersonalState: async (
        input: { viewIds?: string[]; sourceDigests?: string[] },
        onPlanned?: (plan: {
          descriptors: ContextDescriptor[];
          viewIds: string[];
          sourceDigests: string[];
        }) => Promise<void>,
      ) => {
        invalidations += 1;
        const plan = invalidations === 1
          ? { descriptors: [descriptor], viewIds: [], sourceDigests: [descriptor.sourceDigest] }
          : {
            descriptors: [],
            viewIds: input.viewIds ?? [],
            sourceDigests: input.sourceDigests ?? [],
          };
        await onPlanned?.(plan);
        return plan;
      },
      personalStateCleanupEndpoint: () => "http://127.0.0.1:8080",
    } as unknown as ContextController;
    const sourceStore = {
      delete: async (_principal: string, handle: string) => {
        expect(handle).toBe(descriptor.sourceHandle);
        sourceDeletes += 1;
        if (sourceDeletes === 1) throw new Error("injected source deletion failure");
      },
      absent: async () => sourceDeletes > 1,
    } as unknown as LocalContextSourceStore;
    const controller = new PersonalStateController({
      enabled: false,
      journal,
      context,
      sourceStore,
      tokenizer: {} as LlamaContextTokenizer,
      slotAdapter: { erase: async () => undefined } as LlamaContextSlotEraseAdapter,
      sourceMaxBytes: 1_024,
      sourceMaxTotalBytes: 4_096,
      receiptTtlMs: 60_000,
      now: () => Date.parse("2026-09-13T00:00:00.000Z"),
    });
    await controller.initialize();
    const subjectDigest = personalStateSubjectDigest("principal-retry");
    await journal.saveView({
      contractVersion: "larm-personal-state.v1",
      viewRequestId: "view-request-retry",
      subjectDigest,
      requestDigest: "1".repeat(64),
      planDigest: "2".repeat(64),
      idempotencyKeyDigest: "3".repeat(64),
      viewId: "view-retry",
      operationId: "operation-retry",
      allocationId: "allocation-retry",
      runtime: "runtime-retry",
      release: "release-retry",
      bootEpoch: await journal.bootEpoch(),
      dataEpoch: 0,
      dependencies: {
        contextIds: [descriptor.id],
        sourceDigests: [descriptor.sourceDigest],
      },
      state: "invalid",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      expiresAt: "2026-09-13T01:00:00.000Z",
    });
    const request = {
      forgetId: "forget-retry",
      contextIds: [descriptor.id],
      sourceHandles: [],
      attemptIds: [],
    };
    const first = await controller.forget("principal-retry", request);
    expect(first.operation).toMatchObject({
      state: "result_unknown",
      resolved: {
        sourceHandles: [descriptor.sourceHandle],
        sourceDigests: [descriptor.sourceDigest],
        viewIds: ["view-retry"],
      },
      phases: { sources: { state: "failed" } },
    });

    const retried = await controller.forget("principal-retry", request);
    expect(retried.operation).toMatchObject({
      state: "succeeded",
      absenceVerified: true,
      resolved: { sourceHandles: [descriptor.sourceHandle] },
      phases: { sources: { state: "absent" } },
    });
    expect(sourceDeletes).toBe(2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
