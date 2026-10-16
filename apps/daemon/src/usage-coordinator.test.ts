import { expect, test } from "bun:test";
import { UsageCoordinator, UsageProtectionError, claimUsageRequest } from "./usage-coordinator";
import type { MetricsRegistry } from "./metrics";

test("request ownership survives async callback contexts and metrics failures", async () => {
  let now = 0;
  const usage = new UsageCoordinator(() => now, { record: () => { throw new Error("telemetry failed"); } } as unknown as MetricsRegistry, "owner");
  usage.run("owner", () => usage.prepare(600_000, "profile")(true));
  const request = new Request("http://larm/v1/chat/completions");
  usage.run("owner", () => usage.request(request));
  const tracked = claimUsageRequest(request)!;
  expect(() => tracked.check()).not.toThrow();
  expect(tracked.run(() => usage.owner)).toBe("owner");
  expect(() => usage.run("other", () => usage.check())).toThrow(UsageProtectionError);
  now = 900_000;
  expect(() => usage.run("other", () => usage.check())).toThrow(UsageProtectionError);
  tracked.finish(); tracked.finish();
  expect(usage.protection.snapshot()).toMatchObject({ activeRequests: 0, remainingMs: 600_000 });
});

test("reconnecting and probing do not renew the same profile protection", () => {
  let now = 0;
  const usage = new UsageCoordinator(() => now, undefined, "owner");
  usage.run("owner", () => usage.prepare(600_000, "profile")(true));
  now = 500_000;
  usage.run("owner", () => usage.prepare(600_000, "profile")(true));
  usage.run("owner", () => usage.request(new Request("http://larm/probe"), false).finish());
  expect(usage.protection.snapshot().remainingMs).toBe(100_000);
  expect(usage.run("other", () => usage.canProtect)).toBe(false);
  now = 600_000;
  expect(() => usage.run("other", () => usage.check())).not.toThrow();
});

test("failed or repeated preparation completions cannot change the ready profile key", () => {
  let now = 0;
  const usage = new UsageCoordinator(() => now, undefined, "owner");
  usage.run("owner", () => {
    const failed = usage.prepare(600_000, "failed");
    failed(false);
    failed(true);
    usage.prepare(600_000, "failed")(true);
    expect(usage.protection.snapshot().remainingMs).toBe(600_000);
    const old = usage.prepare(600_000, "old");
    old(true);
    usage.prepare(600_000, "new")(true);
    old(true);
    now = 100_000;
    usage.prepare(600_000, "new")(true);
    expect(usage.protection.snapshot().remainingMs).toBe(500_000);
  });
});

test("handover blocks overlapping transfers and new inference, and clears after synchronous failure", async () => {
  const usage = new UsageCoordinator(undefined, undefined, "owner");
  let release!: () => void;
  const handover = usage.run("owner", () => usage.transfer(() => new Promise<void>(resolve => { release = resolve; })));
  expect(() => usage.run("owner", () => usage.request(new Request("http://larm/inference")))).toThrow(UsageProtectionError);
  await expect(usage.run("owner", () => usage.transfer(async () => {}))).rejects.toBeInstanceOf(UsageProtectionError);
  expect(usage.isTransitioning).toBe(true);
  release(); await handover;
  await expect(usage.run("owner", () => usage.transfer(() => { throw new Error("handover failed"); }))).rejects.toThrow("handover failed");
  expect(usage.isTransitioning).toBe(false);
});
