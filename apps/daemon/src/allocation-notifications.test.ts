import { expect, test } from "bun:test";
import type { Allocation } from "@larm/core";
import { AllocationNotifications } from "./allocation-notifications";

test("state notifications wake all waiters without a polling interval", async () => {
  const notifications = new AllocationNotifications();
  const state = { status: "pending" } as Allocation;
  const waits = [notifications.wait("a", () => state, undefined, 60_000), notifications.wait("a", () => state, undefined, 60_000)];
  expect(notifications.size).toBe(2);
  state.status = "ready";
  notifications.notify("a");
  expect(await Promise.all(waits)).toEqual([state, state]);
  expect(notifications.size).toBe(0);
  expect(await notifications.wait("a", () => state, undefined, 60_000)).toBe(state);
  expect(notifications.size).toBe(0);
});

test("timeout, failure, missing state and cancellation clean up subscriptions", async () => {
  const notifications = new AllocationNotifications();
  const abort = new AbortController();
  const state = { status: "waiting" } as Allocation;
  const wait = notifications.wait("a", () => state, abort.signal, 60_000);
  abort.abort(new Error("cancelled"));
  await expect(wait).rejects.toThrow("cancelled");
  expect(notifications.size).toBe(0);
  expect(await notifications.wait("a", () => state, undefined, 1)).toBe(state);
  state.status = "failed";
  expect(await notifications.wait("a", () => state, undefined, 60_000)).toBe(state);
  expect(await notifications.wait("missing", () => undefined, undefined, 60_000)).toBeUndefined();
  expect(notifications.size).toBe(0);
});
