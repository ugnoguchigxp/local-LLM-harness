import { expect, test } from "bun:test";
import { UsageProtection } from "./usage-protection";

test("protects long requests and exactly 600 seconds from the last completion", () => {
  let now = 0;
  const protection = new UsageProtection(() => now);
  const ready = protection.prepare("owner", 600_000);
  expect(protection.denied("other")).toBe(true);
  ready(true); ready(false);
  const first = protection.begin("owner");
  const last = protection.begin("owner");
  now = 900_000;
  first(); first();
  expect(protection.snapshot().activeRequests).toBe(1);
  now += 700_000;
  expect(protection.denied("other")).toBe(true);
  last();
  now += 599_999;
  expect(protection.denied("other")).toBe(true);
  expect(protection.denied("owner")).toBe(false);
  now++;
  expect(protection.denied("other")).toBe(false);
  expect(protection.relinquish("other")).toBe(true);
  expect(protection.snapshot().owner).toBeUndefined();
});

test("failed preparation and invalid requests do not leave or extend protection", () => {
  let now = 0;
  const protection = new UsageProtection(() => now);
  const failed = protection.prepare("owner", 600_000);
  failed(false);
  expect(protection.denied("other")).toBe(false);
  protection.prepare("owner", 600_000)(true);
  now = 100_000;
  protection.begin("owner")(false);
  expect(protection.snapshot().remainingMs).toBe(500_000);
  expect(protection.relinquish("other")).toBe(false);
  expect(() => protection.prepare("other", 600_000)).toThrow();
});

test("late completion from an older generation cannot affect a new owner", () => {
  let now = 0;
  const protection = new UsageProtection(() => now);
  protection.prepare("owner", 600_000)(true);
  const finish = protection.begin("owner"); finish();
  now = 600_000;
  protection.prepare("next", 600_000)(true);
  finish();
  expect(protection.snapshot()).toMatchObject({ owner: "next", activeRequests: 0, remainingMs: 600_000 });
});
