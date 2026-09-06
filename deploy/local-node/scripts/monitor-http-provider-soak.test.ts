import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HttpProviderLiveSmokeResult } from "./smoke-http-provider-live";
import { recordHttpProviderSoak } from "./monitor-http-provider-soak";

const releaseCommit = "a".repeat(40);
const configRevision = "b".repeat(64);

function smoke(
  overrides: Partial<HttpProviderLiveSmokeResult> = {},
): HttpProviderLiveSmokeResult {
  return {
    schemaVersion: 1,
    kind: "http-provider-canary",
    ok: true,
    desiredRelease: releaseCommit,
    observedAt: "2026-09-06T00:00:00.000Z",
    releaseCommit,
    configRevision,
    bootEpoch: "epoch-one",
    model: "coding-default",
    jsonValidated: true,
    sse: { chunks: 2, deltas: 1, finishReasons: 1 },
    audio: null,
    ...overrides,
  };
}

test("soak monitor accumulates one exact Provider generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-http-soak-"));
  const statePath = join(root, "status.json");
  try {
    let now = Date.parse("2026-09-06T00:00:00.000Z");
    for (let sample = 0; sample < 97; sample += 1) {
      const state = await recordHttpProviderSoak({
        statePath,
        now: () => now,
        runSmoke: async () => smoke(),
      });
      now += 15 * 60 * 1_000;
      if (sample === 96) {
        expect(state).toMatchObject({
          ok: true,
          sampleCount: 97,
          failureCount: 0,
          durationSeconds: 86_400,
          maxGapSeconds: 900,
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("soak monitor preserves failures until the Provider generation changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-http-soak-"));
  const statePath = join(root, "status.json");
  try {
    let now = Date.parse("2026-09-06T00:00:00.000Z");
    await recordHttpProviderSoak({
      statePath,
      now: () => now,
      runSmoke: async () => smoke(),
    });
    now += 15 * 60 * 1_000;
    await expect(recordHttpProviderSoak({
      statePath,
      now: () => now,
      runSmoke: async () => {
        throw new Error("provider unavailable");
      },
    })).rejects.toThrow("provider unavailable");
    now += 15 * 60 * 1_000;
    const stillFailed = await recordHttpProviderSoak({
      statePath,
      now: () => now,
      runSmoke: async () => smoke(),
    });
    expect(stillFailed).toMatchObject({ ok: false, sampleCount: 2, failureCount: 1 });

    now += 15 * 60 * 1_000;
    const reset = await recordHttpProviderSoak({
      statePath,
      now: () => now,
      runSmoke: async () => smoke({
        releaseCommit: "c".repeat(40),
        desiredRelease: "c".repeat(40),
        bootEpoch: "epoch-two",
      }),
    });
    expect(reset).toMatchObject({
      ok: true,
      sampleCount: 1,
      failureCount: 0,
      durationSeconds: 0,
      maxGapSeconds: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
