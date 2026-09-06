export const INFRA_PROVIDER_PAUSE_REASONS = [
  "provider_unavailable",
  "provider_unavailable_exhausted",
] as const;

export type InfraProviderPauseReason =
  (typeof INFRA_PROVIDER_PAUSE_REASONS)[number];

export interface ProviderGeneration {
  releaseCommit: string;
  configurationRevision: string;
  bootEpoch: string;
}

export interface ProviderRecoveryRelease {
  desiredRelease: string;
  observedRelease: string | null;
  stage:
    | "approved"
    | "validated"
    | "activated"
    | "contract_verified"
    | "canary_verified"
    | "consumer_verified"
    | "soak_verified"
    | "complete";
  result: "pending" | "running" | "succeeded" | "failed";
}

export interface ProviderRecoveryCanary {
  jsonCompleted: boolean;
  sseCompleted: boolean;
}

export interface RecoverablePausedJob {
  id: string;
  pausedAt: string;
  pauseOrigin: "infra" | "manual" | "business";
  pauseReason: string;
  failedProviderGeneration: string | null;
}

export interface ProviderRecoveryWave {
  providerGeneration: string;
  batchSize: number;
  outcome: "pending" | "succeeded" | "failed";
}

export interface ProviderRecoveryInput {
  generation: ProviderGeneration;
  release: ProviderRecoveryRelease;
  healthOk: boolean;
  ready: boolean;
  canary: ProviderRecoveryCanary;
  pausedJobs: readonly RecoverablePausedJob[];
  previousWave?: ProviderRecoveryWave;
  maximumBatchSize?: number;
}

export type ProviderRecoveryPlan =
  | {
    action: "wait";
    reason:
      | "release_identity_mismatch"
      | "release_not_canary_verified"
      | "release_failed"
      | "provider_not_ready"
      | "canary_incomplete"
      | "previous_wave_pending"
      | "previous_wave_failed"
      | "no_eligible_jobs";
    providerGeneration: string;
    resumeJobIds: [];
    nextBatchSize: 0;
  }
  | {
    action: "resume";
    reason: "new_verified_generation" | "previous_wave_succeeded";
    providerGeneration: string;
    resumeJobIds: string[];
    nextBatchSize: number;
  };

const CANARY_VERIFIED_STAGES = new Set<ProviderRecoveryRelease["stage"]>([
  "canary_verified",
  "consumer_verified",
  "soak_verified",
  "complete",
]);

function waitPlan(
  reason: Extract<ProviderRecoveryPlan, { action: "wait" }>["reason"],
  providerGeneration: string,
): ProviderRecoveryPlan {
  return {
    action: "wait",
    reason,
    providerGeneration,
    resumeJobIds: [],
    nextBatchSize: 0,
  };
}

export function providerGenerationKey(generation: ProviderGeneration): string {
  return [
    generation.releaseCommit,
    generation.configurationRevision,
    generation.bootEpoch,
  ].map((part) => encodeURIComponent(part)).join("/");
}

export function isInfraProviderPause(job: RecoverablePausedJob): boolean {
  return job.pauseOrigin === "infra"
    && INFRA_PROVIDER_PAUSE_REASONS.includes(
      job.pauseReason as InfraProviderPauseReason,
    );
}

export function planProviderRecovery(
  input: ProviderRecoveryInput,
): ProviderRecoveryPlan {
  const generation = providerGenerationKey(input.generation);
  if (
    input.release.observedRelease === null
    || input.release.desiredRelease !== input.release.observedRelease
    || input.release.observedRelease !== input.generation.releaseCommit
  ) {
    return waitPlan("release_identity_mismatch", generation);
  }
  if (input.release.result === "failed") {
    return waitPlan("release_failed", generation);
  }
  if (!CANARY_VERIFIED_STAGES.has(input.release.stage)) {
    return waitPlan("release_not_canary_verified", generation);
  }
  if (!input.healthOk || !input.ready) {
    return waitPlan("provider_not_ready", generation);
  }
  if (!input.canary.jsonCompleted || !input.canary.sseCompleted) {
    return waitPlan("canary_incomplete", generation);
  }
  if (
    input.previousWave?.providerGeneration === generation
    && input.previousWave.outcome === "pending"
  ) {
    return waitPlan("previous_wave_pending", generation);
  }
  if (
    input.previousWave?.providerGeneration === generation
    && input.previousWave.outcome === "failed"
  ) {
    return waitPlan("previous_wave_failed", generation);
  }

  const maximumBatchSize = Math.max(
    1,
    Math.min(64, Math.trunc(input.maximumBatchSize ?? 4)),
  );
  const previousSucceeded = input.previousWave?.providerGeneration === generation
    && input.previousWave.outcome === "succeeded";
  const batchSize = previousSucceeded
    ? Math.min(maximumBatchSize, Math.max(1, input.previousWave!.batchSize * 2))
    : 1;
  const eligible = [...input.pausedJobs]
    .filter((job) =>
      isInfraProviderPause(job)
      && job.failedProviderGeneration !== null
      && job.failedProviderGeneration !== generation
    )
    .sort((left, right) =>
      left.pausedAt.localeCompare(right.pausedAt) || left.id.localeCompare(right.id)
    )
    .slice(0, batchSize);

  if (eligible.length === 0) {
    return waitPlan("no_eligible_jobs", generation);
  }
  return {
    action: "resume",
    reason: previousSucceeded
      ? "previous_wave_succeeded"
      : "new_verified_generation",
    providerGeneration: generation,
    resumeJobIds: eligible.map((job) => job.id),
    nextBatchSize: batchSize,
  };
}
