import type { Allocation, Registry, RuntimeReleaseDefinition } from "@larm/core";
import type { ContextRuntimeStatus } from "./context-controller-types";
import { ContextControllerError } from "./context-controller-errors";

export type ContextProductRuntimeBinding = {
  endpoint: string;
  release: string;
  leaseEpoch: number;
  tokenizerDigest: string;
  chatTemplateDigest: string;
  contextLimitTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  sourceTokenLimit: number;
  leaseExpiresAt: string;
  materializedMaxBytes: number;
  operationTimeoutMs: number;
  filesystemFreeFloorBytes: number;
};

export class ContextRuntimeEligibility {
  constructor(private readonly dependencies: {
    enabled: boolean;
    registry: Registry;
    releases: ReadonlyMap<string, RuntimeReleaseDefinition>;
    getAllocation: (id: string) => Allocation | undefined;
    getActivation: (runtime: string) => ContextRuntimeStatus;
    materializedMaxBytes: number;
  }) {}

  productRuntimeBinding(allocationId: string, runtimeId: string): ContextProductRuntimeBinding {
    const d = this.dependencies;
    if (!d.enabled) {
      throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
    }
    const allocation = d.getAllocation(allocationId);
    const binding = allocation?.status === "ready"
      ? allocation.bindings.find((candidate) => candidate.runtime === runtimeId)
      : undefined;
    const activation = d.getActivation(runtimeId);
    const runtime = d.registry.runtimes.find((candidate) => candidate.id === runtimeId);
    const release = binding?.release ? d.releases.get(binding.release) : undefined;
    if (
      !allocation
      || !binding?.release
      || (activation.state !== "ACTIVE" && activation.state !== "BUSY")
      || activation.release !== binding.release
      || runtime?.context?.class !== "managed-context"
      || !release?.contextCertification
    ) {
      throw new ContextControllerError(409, "no_eligible_runtime_active", "runtime binding is not active");
    }
    return {
      endpoint: runtime.deployment.endpoint,
      release: release.id,
      leaseEpoch: activation.leaseEpoch,
      tokenizerDigest: release.contextCertification.tokenizerDigest,
      chatTemplateDigest: release.contextCertification.chatTemplateDigest,
      contextLimitTokens: release.contextCertification.contextLimitTokens,
      outputReserveTokens: runtime.context.outputReserveTokens,
      safetyMarginTokens: runtime.context.safetyMarginTokens,
      sourceTokenLimit: runtime.context.sourceTokenLimit,
      leaseExpiresAt: allocation.expiresAt,
      materializedMaxBytes: d.materializedMaxBytes,
      operationTimeoutMs: runtime.context.operationTimeoutMs,
      filesystemFreeFloorBytes: runtime.context.filesystemFreeFloorBytes,
    };
  }

  personalStateCleanupEndpoint(runtimeId: string): string | undefined {
    const runtime = this.dependencies.registry.runtimes.find((candidate) => candidate.id === runtimeId);
    return runtime?.context?.class === "managed-context"
      ? runtime.deployment.endpoint
      : undefined;
  }
}
