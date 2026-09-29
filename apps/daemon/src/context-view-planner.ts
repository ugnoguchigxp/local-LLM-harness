import {
  contextCompatibilityKey,
  planActiveContextView,
  type ActiveContextView,
  type Allocation,
  type ContextDescriptor,
  type ContextPlanCandidate,
  type ContextViewOmission,
  type ContextViewRequest,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";
import type { ContextRuntimeStatus } from "./context-controller-types";

export function planContextView(input: {
  request: ContextViewRequest;
  principal: string;
  allocation: Allocation;
  runtime: Registry["runtimes"][number] | undefined;
  getRelease: (releaseId: string) => RuntimeReleaseDefinition | undefined;
  getActivation: () => ContextRuntimeStatus;
  descriptors: Iterable<ContextDescriptor>;
  getDescriptor: (principal: string, contextId: string, version: string) => ContextDescriptor | undefined;
  now: () => number;
  createViewId: () => string;
  createOperationId: () => string;
  createdAt: () => string;
}): ActiveContextView {
  const { request, principal, allocation, runtime } = input;
  const binding = allocation.bindings.find((candidate) => candidate.runtime === request.runtime);
  if (!binding || !binding.release) {
    throw new ContextControllerError(
      409,
      "no_eligible_runtime_active",
      "allocation is not bound to the requested runtime release",
    );
  }
  const activation = input.getActivation();
  if (activation.state !== "ACTIVE" && activation.state !== "BUSY") {
    throw new ContextControllerError(
      409,
      "no_eligible_runtime_active",
      `context runtime is ${activation.state}: ${activation.reason}`,
    );
  }
  if (activation.release !== binding.release) {
    throw new ContextControllerError(409, "context_view_stale", "allocation release is no longer active");
  }
  const release = input.getRelease(binding.release);
  if (runtime?.context?.class !== "managed-context" || !release?.contextCertification) {
    throw new ContextControllerError(409, "no_eligible_runtime_active", "context certification is unavailable");
  }
  const certification = release.contextCertification;
  const sourceSetTokens = [...input.descriptors]
    .filter((descriptor) =>
      descriptor.principal === principal
      && descriptor.state === "active"
      && descriptor.tokenizerDigest === certification.tokenizerDigest
    )
    .reduce((total, descriptor) => total + descriptor.tokenCount, 0);
  if (sourceSetTokens > runtime.context.sourceTokenLimit) {
    throw new ContextControllerError(
      409,
      "context_source_limit_exceeded",
      `runtime source set exceeds ${runtime.context.sourceTokenLimit} tokens`,
    );
  }

  const candidates: ContextPlanCandidate[] = [];
  const omissions: ContextViewOmission[] = [];
  for (const item of request.items) {
    const descriptor = input.getDescriptor(principal, item.contextId, item.version);
    let reason: ContextViewOmission["reason"] | undefined;
    if (!descriptor) reason = "not_found";
    else if (
      descriptor.state !== "active"
      || (descriptor.expiresAt && Date.parse(descriptor.expiresAt) <= input.now())
    ) reason = "invalid";
    else if (descriptor.tokenizerDigest !== certification.tokenizerDigest) reason = "tokenizer_mismatch";
    if (reason) {
      if (item.required) {
        throw new ContextControllerError(
          reason === "not_found" ? 404 : 409,
          reason === "not_found" ? "context_not_found" : "context_source_invalid",
          `required context ${item.contextId}@${item.version} is ${reason}`,
        );
      }
      omissions.push({ contextId: item.contextId, version: item.version, reason });
    } else {
      candidates.push({ plan: item, descriptor: descriptor! });
    }
  }
  const planned = planActiveContextView({
    policy: runtime.context,
    certification,
    baseInputTokens: request.baseInputTokens,
    maxInputTokens: request.maxInputTokens,
    canonicalizationVersion: request.canonicalizationVersion,
    candidates,
    omissions,
  });
  if (!planned.ok) {
    throw new ContextControllerError(
      422,
      "context_budget_exceeded",
      `required input ${planned.requiredTokens} exceeds budget ${planned.inputBudgetTokens}`,
    );
  }
  const deadline = Date.parse(request.deadline);
  const expiresAtMs = Math.min(
    deadline,
    Date.parse(allocation.expiresAt),
    input.now() + runtime.context.operationTimeoutMs,
  );
  if (!Number.isFinite(deadline) || expiresAtMs <= input.now()) {
    throw new ContextControllerError(410, "context_view_stale", "context view deadline has expired");
  }
  const viewId = input.createViewId();
  const operationId = input.createOperationId();
  const createdAt = input.createdAt();
  return {
    schemaVersion: 1,
    id: viewId,
    operationId,
    principal,
    allocationId: allocation.id,
    runtime: runtime.id,
    release: release.id,
    compatibilityKey: contextCompatibilityKey({
      release: release.id,
      certification,
      principalScope: principal,
    }),
    viewDigest: planned.viewDigest,
    canonicalizationVersion: request.canonicalizationVersion,
    baseInputTokens: request.baseInputTokens,
    inputBudgetTokens: planned.inputBudgetTokens,
    tokenCount: planned.tokenCount,
    orderedItems: planned.orderedItems,
    omitted: planned.omitted,
    leaseEpoch: activation.leaseEpoch,
    state: "ready",
    createdAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
