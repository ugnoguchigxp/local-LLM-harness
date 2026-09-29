import type { Allocation, ContextDescriptor, ContextPlanItem, Registry, RuntimeReleaseDefinition } from "@larm/core";
import type { ContextSourceProvider } from "@larm/backends";
import { ContextControllerError } from "./context-controller-errors";
import { materializeMeasurementRequest } from "./context-request-materializer";

export type CanonicalMeasurement = {
  inputTokens: number;
  inputBudgetTokens: number;
  release: string;
  leaseEpoch: number;
  tokenizerDigest: string;
  chatTemplateDigest: string;
  sourceDigests: string[];
};

export type CanonicalMeasurementInput = {
  principal: string;
  allocationId: string;
  runtime: string;
  request: Record<string, unknown>;
  items?: ContextPlanItem[];
  signal?: AbortSignal;
};

export async function measureCanonicalRequest(input: CanonicalMeasurementInput, deps: {
  enabled: boolean;
  registry: Registry;
  getAllocation: (id: string) => Allocation | undefined;
  getActivation: (runtime: string) => { state: string; release?: string; leaseEpoch: number };
  getRelease: (id: string) => RuntimeReleaseDefinition | undefined;
  getDescriptor: (principal: string, contextId: string, version: string) => ContextDescriptor | undefined;
  sourceProvider: ContextSourceProvider;
  sourceMaxBytes: number;
  materializedMaxBytes: number;
  countChatTokens: (
    endpoint: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<number>;
  now: () => number;
}): Promise<CanonicalMeasurement> {
  if (!deps.enabled) {
    throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
  }
  const allocation = deps.getAllocation(input.allocationId);
  if (!allocation || allocation.status !== "ready") {
    throw new ContextControllerError(409, "no_eligible_runtime_active", "allocation is not ready");
  }
  const binding = allocation.bindings.find((candidate) => candidate.runtime === input.runtime);
  const activation = deps.getActivation(input.runtime);
  if (
    !binding?.release
    || (activation.state !== "ACTIVE" && activation.state !== "BUSY")
    || activation.release !== binding.release
  ) {
    throw new ContextControllerError(409, "no_eligible_runtime_active", "runtime binding is not active");
  }
  const runtime = deps.registry.runtimes.find((candidate) => candidate.id === input.runtime);
  const release = deps.getRelease(binding.release);
  if (runtime?.context?.class !== "managed-context" || !release?.contextCertification) {
    throw new ContextControllerError(409, "no_eligible_runtime_active", "context certification is unavailable");
  }
  const materialized = await materializeMeasurementRequest({
    principal: input.principal,
    original: input.request,
    items: input.items ?? [],
    getDescriptor: (contextId, version) => deps.getDescriptor(input.principal, contextId, version),
    sourceProvider: deps.sourceProvider,
    sourceMaxBytes: deps.sourceMaxBytes,
    materializedMaxBytes: deps.materializedMaxBytes,
    now: deps.now,
    signal: input.signal,
  });
  let inputTokens: number;
  try {
    inputTokens = await deps.countChatTokens(runtime.deployment.endpoint, materialized.request, input.signal);
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new ContextControllerError(
      503,
      "context_subsystem_degraded",
      `canonical chat tokenization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    inputTokens,
    inputBudgetTokens: Math.max(0, Math.min(
      release.contextCertification.contextLimitTokens
        - runtime.context.outputReserveTokens
        - runtime.context.safetyMarginTokens,
      release.contextCertification.contextLimitTokens,
    )),
    release: release.id,
    leaseEpoch: activation.leaseEpoch,
    tokenizerDigest: release.contextCertification.tokenizerDigest,
    chatTemplateDigest: release.contextCertification.chatTemplateDigest,
    sourceDigests: materialized.sourceDigests,
  };
}
