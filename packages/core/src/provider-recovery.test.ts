import { expect, test } from "bun:test";
import {
  planProviderRecovery,
  providerGenerationKey,
  type ProviderRecoveryInput,
  type RecoverablePausedJob,
} from "./provider-recovery";

const oldGeneration = providerGenerationKey({
  releaseCommit: "1".repeat(40),
  configurationRevision: "config-old",
  bootEpoch: "boot-old",
});
const generation = {
  releaseCommit: "2".repeat(40),
  configurationRevision: "config-new",
  bootEpoch: "boot-new",
};
const baseJob: RecoverablePausedJob = {
  id: "job-1",
  pausedAt: "2026-09-06T01:00:00.000Z",
  pauseOrigin: "infra",
  pauseReason: "provider_unavailable_exhausted",
  failedProviderGeneration: oldGeneration,
};
const baseInput: ProviderRecoveryInput = {
  generation,
  release: {
    desiredRelease: generation.releaseCommit,
    observedRelease: generation.releaseCommit,
    stage: "canary_verified",
    result: "running",
  },
  healthOk: true,
  ready: true,
  canary: {
    jsonCompleted: true,
    sseCompleted: true,
  },
  pausedJobs: [baseJob],
};

test("starts recovery with exactly one oldest infrastructure-paused job", () => {
  const plan = planProviderRecovery({
    ...baseInput,
    pausedJobs: [
      { ...baseJob, id: "job-2", pausedAt: "2026-09-06T02:00:00.000Z" },
      baseJob,
      {
        ...baseJob,
        id: "manual",
        pausedAt: "2026-09-06T00:00:00.000Z",
        pauseOrigin: "manual",
      },
      {
        ...baseJob,
        id: "business",
        pauseOrigin: "business",
        pauseReason: "invalid_input",
      },
    ],
  });

  expect(plan).toMatchObject({
    action: "resume",
    reason: "new_verified_generation",
    resumeJobIds: ["job-1"],
    nextBatchSize: 1,
  });
});

test("does not resume on the same generation or without complete canaries", () => {
  const currentGeneration = providerGenerationKey(generation);
  expect(planProviderRecovery({
    ...baseInput,
    pausedJobs: [{ ...baseJob, failedProviderGeneration: currentGeneration }],
  })).toMatchObject({
    action: "wait",
    reason: "no_eligible_jobs",
  });
  expect(planProviderRecovery({
    ...baseInput,
    canary: { jsonCompleted: true, sseCompleted: false },
  })).toMatchObject({
    action: "wait",
    reason: "canary_incomplete",
  });
  expect(planProviderRecovery({
    ...baseInput,
    release: { ...baseInput.release, stage: "contract_verified" },
  })).toMatchObject({
    action: "wait",
    reason: "release_not_canary_verified",
  });
});

test("fails closed on identity mismatch, failed release, and unhealthy provider", () => {
  expect(planProviderRecovery({
    ...baseInput,
    release: { ...baseInput.release, observedRelease: "3".repeat(40) },
  })).toMatchObject({
    action: "wait",
    reason: "release_identity_mismatch",
  });
  expect(planProviderRecovery({
    ...baseInput,
    release: { ...baseInput.release, result: "failed" },
  })).toMatchObject({
    action: "wait",
    reason: "release_failed",
  });
  expect(planProviderRecovery({
    ...baseInput,
    ready: false,
  })).toMatchObject({
    action: "wait",
    reason: "provider_not_ready",
  });
});

test("expands only after a successful wave and stops after pending or failed waves", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    ...baseJob,
    id: `job-${index + 1}`,
    pausedAt: `2026-09-06T0${index}:00:00.000Z`,
  }));
  const providerGeneration = providerGenerationKey(generation);
  expect(planProviderRecovery({
    ...baseInput,
    pausedJobs: jobs,
    previousWave: {
      providerGeneration,
      batchSize: 1,
      outcome: "succeeded",
    },
  })).toMatchObject({
    action: "resume",
    resumeJobIds: ["job-1", "job-2"],
    nextBatchSize: 2,
  });
  expect(planProviderRecovery({
    ...baseInput,
    pausedJobs: jobs,
    previousWave: {
      providerGeneration,
      batchSize: 2,
      outcome: "succeeded",
    },
  })).toMatchObject({
    action: "resume",
    nextBatchSize: 4,
  });
  expect(planProviderRecovery({
    ...baseInput,
    pausedJobs: jobs,
    previousWave: {
      providerGeneration,
      batchSize: 1,
      outcome: "pending",
    },
  })).toMatchObject({
    action: "wait",
    reason: "previous_wave_pending",
  });
  expect(planProviderRecovery({
    ...baseInput,
    pausedJobs: jobs,
    previousWave: {
      providerGeneration,
      batchSize: 1,
      outcome: "failed",
    },
  })).toMatchObject({
    action: "wait",
    reason: "previous_wave_failed",
  });
});
