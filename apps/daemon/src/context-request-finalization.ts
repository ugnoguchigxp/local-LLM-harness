import type { ActiveContextView, ContextOperation, Registry } from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";

type ManagedRuntime = Registry["runtimes"][number];

export async function finalizeActiveContextViewRequest(input: {
  view: ActiveContextView;
  request: Record<string, unknown>;
  runtime: ManagedRuntime | undefined;
  inputSignal?: AbortSignal;
  deadlineSignal: AbortSignal;
  materializationSignal: AbortSignal;
  materializedMaxBytes: number;
  countChatTokens: (
    endpoint: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<number>;
}, callbacks: {
  clearMaterializing: () => void;
  updateOperation: (
    state: ContextOperation["state"],
    outcome?: string,
  ) => void;
  onTokenizerUnavailable: (reason: string) => void;
  onConsuming: () => void;
  onConsumed: (inputTokens: number) => void;
}): Promise<Uint8Array> {
  const { view, runtime } = input;
  if (!runtime || runtime.context?.class !== "managed-context") {
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation("failed", "context_view_stale");
    throw new ContextControllerError(409, "context_view_stale", "context runtime no longer exists");
  }

  const outputFields = [input.request.max_tokens, input.request.max_completion_tokens]
    .filter((value) => value !== undefined);
  if (outputFields.some((value) => !Number.isSafeInteger(value) || (value as number) < 1)) {
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation("failed", "context_request_invalid");
    throw new ContextControllerError(
      400,
      "context_request_invalid",
      "max_tokens and max_completion_tokens must be positive integers",
    );
  }
  const requestedOutputTokens = outputFields.length > 0
    ? Math.max(...outputFields as number[])
    : runtime.context.outputReserveTokens;
  if (requestedOutputTokens > runtime.context.outputReserveTokens) {
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation("failed", "context_budget_exceeded");
    throw new ContextControllerError(
      422,
      "context_budget_exceeded",
      `requested output ${requestedOutputTokens} exceeds reserved output ${runtime.context.outputReserveTokens}`,
    );
  }
  if (outputFields.length === 0) input.request.max_tokens = runtime.context.outputReserveTokens;

  let actualInputTokens: number;
  try {
    actualInputTokens = await input.countChatTokens(
      runtime.deployment.endpoint,
      input.request,
      input.materializationSignal,
    );
  } catch {
    const cancelled = input.materializationSignal.aborted;
    callbacks.onTokenizerUnavailable("context_tokenizer_unavailable");
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation(
      cancelled ? "cancelled" : "failed",
      cancelled ? "context_materialization_cancelled" : "context_tokenizer_unavailable",
    );
    if (input.inputSignal?.aborted) {
      throw input.inputSignal.reason ?? new Error("context request cancelled");
    }
    if (input.deadlineSignal.aborted) {
      throw new ContextControllerError(410, "context_view_stale", "context view deadline expired");
    }
    throw new ContextControllerError(
      503,
      "context_subsystem_degraded",
      "canonical chat tokenization failed",
    );
  }

  if (actualInputTokens > view.inputBudgetTokens) {
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation("failed", "context_budget_exceeded");
    throw new ContextControllerError(
      422,
      "context_budget_exceeded",
      `canonical chat input ${actualInputTokens} exceeds budget ${view.inputBudgetTokens}`,
    );
  }
  if (view.state !== "ready") {
    callbacks.clearMaterializing();
    callbacks.updateOperation("cancelled", "personal_state_forgotten");
    throw new ContextControllerError(409, "context_view_stale", "context view was invalidated during use");
  }

  const prepared = new TextEncoder().encode(JSON.stringify(input.request));
  if (prepared.byteLength > input.materializedMaxBytes) {
    view.state = "invalid";
    callbacks.clearMaterializing();
    callbacks.updateOperation("failed", "context_materialization_too_large");
    throw new ContextControllerError(
      422,
      "context_materialization_too_large",
      `materialized request exceeds ${input.materializedMaxBytes} bytes`,
    );
  }

  view.state = "consumed";
  callbacks.clearMaterializing();
  callbacks.onConsuming();
  callbacks.updateOperation("succeeded", "source_rebuild_materialized");
  callbacks.onConsumed(actualInputTokens);
  return prepared;
}
