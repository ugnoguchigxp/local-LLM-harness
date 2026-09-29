import { expect, test } from "bun:test";
import type { Allocation } from "@larm/core";
import { AllocationTimers } from "./allocation-timers";

function fakeTimers() {
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const timers = new AllocationTimers({
    schedule: (callback, delayMs) => {
      const item = { callback, delayMs, cancelled: false };
      scheduled.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (timer) => {
      (timer as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  return { timers, scheduled };
}

test("waiting promotion coalesces timers, cancels, and does not schedule during drain", () => {
  const { timers, scheduled } = fakeTimers();
  const promoted: string[] = [];
  const input = {
    draining: false,
    hasWaiting: true,
    delayMs: 20,
    promote: () => promoted.push("promote"),
  };
  timers.scheduleWaitingPromotion(input);
  timers.scheduleWaitingPromotion(input);
  expect(scheduled).toHaveLength(1);
  timers.cancelWaitingPromotion();
  expect(scheduled[0]?.cancelled).toBe(true);
  timers.scheduleWaitingPromotion({ ...input, draining: true });
  expect(scheduled).toHaveLength(1);
  timers.scheduleWaitingPromotion(input);
  scheduled[1]?.callback();
  expect(promoted).toEqual(["promote"]);
});

test("idle stop replaces its timer, supports immediate stop, and respects drain", () => {
  const { timers, scheduled } = fakeTimers();
  const queued: Array<() => Promise<void>> = [];
  const stopped: string[][] = [];
  const input = {
    draining: false,
    ttlMs: 10,
    ids: ["worker"],
    enqueue: (work: () => Promise<void>) => queued.push(work),
    runStop: async (ids: string[]) => { stopped.push(ids); },
  };
  timers.scheduleIdleStop(input);
  timers.scheduleIdleStop({ ...input, ids: ["resident"] });
  expect(scheduled).toHaveLength(2);
  expect(scheduled[0]?.cancelled).toBe(true);
  timers.scheduleIdleStop({ ...input, ttlMs: 0, ids: ["immediate"] });
  expect(queued).toHaveLength(1);
  timers.scheduleIdleStop({ ...input, draining: true, ids: ["ignored"] });
  expect(scheduled).toHaveLength(2);
  scheduled[1]?.callback();
  expect(queued).toHaveLength(2);
  void queued[0]?.();
  void queued[1]?.();
  expect(stopped).toEqual([["immediate"], ["resident"]]);
});

test("allocation expiries replace and clear timers; due scan only expires active records", () => {
  const { timers, scheduled } = fakeTimers();
  const expired: string[] = [];
  timers.scheduleAllocationExpiry({
    id: "a",
    expiresAt: new Date(500).toISOString(),
    now: 100,
    expire: (id) => expired.push(id),
  });
  timers.scheduleAllocationExpiry({
    id: "a",
    expiresAt: new Date(700).toISOString(),
    now: 100,
    expire: (id) => expired.push(id),
  });
  expect(scheduled[0]?.cancelled).toBe(true);
  expect(scheduled[1]?.delayMs).toBe(600);
  scheduled[1]?.callback();
  expect(expired).toEqual(["a"]);
  timers.clearAllocationExpiry("a");
  expect(scheduled[1]?.cancelled).toBe(true);

  timers.expireDueAllocations({
    allocations: [
      { id: "active", status: "ready", expiresAt: new Date(90).toISOString() },
      { id: "terminal", status: "released", expiresAt: new Date(90).toISOString() },
    ] as unknown as Allocation[],
    now: 100,
    isActive: (status) => status === "ready",
    expire: (id) => expired.push(id),
  });
  expect(expired).toEqual(["a", "active"]);
});
