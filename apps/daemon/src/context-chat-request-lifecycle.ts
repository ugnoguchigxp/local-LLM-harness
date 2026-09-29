import { personalStateDigest, type ActiveContextView, type ContextDescriptor, type ContextOperation, type Registry } from "@larm/core";
import type { ContextSourceProvider } from "@larm/backends";
import type { ContextRuntimeStatus } from "./context-controller-types";
import { ContextControllerError } from "./context-controller-errors";
import { materializeActiveContextViewRequest } from "./context-request-materializer";
import { finalizeActiveContextViewRequest } from "./context-request-finalization";
import { assertContextViewMaterializable } from "./context-view-admission";

export class ContextChatRequestLifecycle {
  constructor(private readonly dependencies: {
    registry: Registry;
    views: Map<string, ActiveContextView>;
    operations: Map<string, ContextOperation>;
    materializingViews: Set<string>;
    initialize: () => Promise<void>;
    prune: () => void;
    now: () => number;
    getActivation: (runtime: string) => ContextRuntimeStatus;
    getDescriptor: (principal: string, contextId: string, version: string) => ContextDescriptor | undefined;
    sourceProvider: ContextSourceProvider;
    sourceMaxBytes: number;
    materializedMaxBytes: number;
    countChatTokens: (endpoint: string, request: Record<string, unknown>, signal?: AbortSignal) => Promise<number>;
    setProbe: (runtime: string, release: string, ok: boolean, reason: string) => void;
    updateOperation: (id: string, state: ContextOperation["state"], outcome?: string) => void;
    emit: (name: string, labels: Record<string, string>, value?: number) => void;
  }) {}

  async prepare(input: {
    viewId: string;
    principal: string;
    allocationId: string;
    runtime: string;
    release: string;
    attemptId?: string;
    requestBody: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const d = this.dependencies;
    await d.initialize();
    d.prune();
    const view = assertContextViewMaterializable({
      view: d.views.get(input.viewId),
      principal: input.principal,
      allocationId: input.allocationId,
      runtime: input.runtime,
      release: input.release,
      isMaterializing: d.materializingViews.has(input.viewId),
      now: d.now,
      getActivation: () => d.getActivation(input.runtime),
    });

    let request: Record<string, unknown>;
    try {
      const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.requestBody));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || !Array.isArray(decoded.messages)) {
        throw new Error("messages are required");
      }
      request = decoded;
    } catch {
      throw new ContextControllerError(400, "context_request_invalid", "chat request must be valid UTF-8 JSON");
    }
    const requestDigest = personalStateDigest(request);
    if (view.requestDigest && view.requestDigest !== requestDigest) {
      view.state = "invalid";
      d.updateOperation(view.operationId, "failed", "request_digest_mismatch");
      throw new ContextControllerError(
        409,
        "request_digest_mismatch",
        "chat request does not match the request measured for this view",
      );
    }
    d.materializingViews.add(view.id);
    d.updateOperation(view.operationId, "running");
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Date.parse(view.expiresAt) - d.now()));
    const materializationSignal = input.signal
      ? AbortSignal.any([input.signal, deadlineSignal])
      : deadlineSignal;
    const runtime = d.registry.runtimes.find((candidate) => candidate.id === input.runtime);
    let materialized: Record<string, unknown>;
    try {
      materialized = await materializeActiveContextViewRequest({
        principal: input.principal,
        original: request,
        baseRequestBytes: input.requestBody.byteLength,
        items: view.orderedItems,
        getDescriptor: (contextId, version) => d.getDescriptor(input.principal, contextId, version),
        sourceProvider: d.sourceProvider,
        sourceMaxBytes: d.sourceMaxBytes,
        materializedMaxBytes: d.materializedMaxBytes,
        signal: materializationSignal,
        onOmitted: (omission) => view.omitted.push(omission),
      });
    } catch (error) {
      if (error instanceof ContextControllerError && error.code === "context_request_invalid") {
        d.materializingViews.delete(view.id);
        d.updateOperation(view.operationId, "failed", "context_request_invalid");
        throw error;
      }
      const cancelled = materializationSignal.aborted;
      view.state = "invalid";
      d.materializingViews.delete(view.id);
      d.updateOperation(
        view.operationId,
        cancelled ? "cancelled" : "failed",
        cancelled ? "context_materialization_cancelled" : "context_source_invalid",
      );
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (deadlineSignal.aborted) {
        throw new ContextControllerError(410, "context_view_stale", "context view deadline expired");
      }
      if (error instanceof ContextControllerError) throw error;
      throw new ContextControllerError(409, "context_source_invalid", "context source could not be verified");
    }
    return await finalizeActiveContextViewRequest({
      view,
      request: materialized,
      runtime,
      ...(input.signal ? { inputSignal: input.signal } : {}),
      deadlineSignal,
      materializationSignal,
      materializedMaxBytes: d.materializedMaxBytes,
      countChatTokens: d.countChatTokens,
    }, {
      clearMaterializing: () => d.materializingViews.delete(view.id),
      updateOperation: (state, outcome) => d.updateOperation(view.operationId, state, outcome),
      onTokenizerUnavailable: (reason) => d.setProbe(input.runtime, input.release, false, reason),
      onConsuming: () => {
        const operation = d.operations.get(view.operationId);
        if (operation) operation.mode = "source-rebuild";
      },
      onConsumed: (actualInputTokens) => {
        d.emit("context_prefill_tokens", { runtime: input.runtime, source: "active_view" }, actualInputTokens);
        d.emit("context_view_consumed", { runtime: input.runtime, mode: "source-rebuild" });
      },
    });
  }
}
