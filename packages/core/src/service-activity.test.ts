import { expect, test } from "bun:test";
import {
  createServiceActivity,
  deriveServiceActivityState,
  LARM_SERVICE_ACTIVITY_CONTRACT_VERSION,
  serviceActivitySchema,
} from "./service-activity";

const base = {
  httpActiveWorkloads: 0,
  nativeActiveWorkloads: 0,
  draining: false,
  observedAt: "2026-09-05T17:45:00.000Z",
  bootEpoch: "epoch-test",
  configRevision: "revision-test",
};

test("service activity reports an advisory idle snapshot", () => {
  expect(createServiceActivity(base)).toEqual({
    contractVersion: LARM_SERVICE_ACTIVITY_CONTRACT_VERSION,
    state: "idle",
    activeWorkloads: 0,
    observedAt: base.observedAt,
    validForMs: 1_000,
    retryAfterMs: 0,
    reservationGuaranteed: false,
    bootEpoch: base.bootEpoch,
    configRevision: base.configRevision,
  });
});

test("service activity combines HTTP and native workloads", () => {
  expect(createServiceActivity({
    ...base,
    httpActiveWorkloads: 2,
    nativeActiveWorkloads: 3,
  })).toMatchObject({
    state: "active",
    activeWorkloads: 5,
    retryAfterMs: 1_000,
  });
});

test("draining takes precedence without discarding the observed count", () => {
  expect(createServiceActivity({
    ...base,
    httpActiveWorkloads: 1,
    draining: true,
  })).toMatchObject({
    state: "draining",
    activeWorkloads: 1,
    retryAfterMs: 1_000,
  });
  expect(deriveServiceActivityState(0, true)).toBe("draining");
});

test("service activity rejects invalid counts and extra public fields", () => {
  expect(() => createServiceActivity({ ...base, nativeActiveWorkloads: -1 })).toThrow(RangeError);
  expect(() => createServiceActivity({ ...base, httpActiveWorkloads: 0.5 })).toThrow(RangeError);
  expect(() => serviceActivitySchema.parse({
    ...createServiceActivity(base),
    runtimes: ["qwen-general"],
  })).toThrow();
});

test("service activity schema rejects contradictory state, count, and retry fields", () => {
  const idle = createServiceActivity(base);
  expect(() => serviceActivitySchema.parse({ ...idle, activeWorkloads: 1 })).toThrow();
  expect(() => serviceActivitySchema.parse({
    ...idle,
    state: "active",
    retryAfterMs: 1_000,
  })).toThrow();
  expect(() => serviceActivitySchema.parse({
    ...idle,
    state: "active",
    activeWorkloads: 1,
    retryAfterMs: 0,
  })).toThrow();
});
