import { expect, test } from "bun:test";
import type { Allocation } from "@larm/core";
import type { Operation } from "./controller";
import {
  commitAllocationOperationTerminal,
  commitAllocationStartupFailure,
  commitAllocationStartupReady,
  commitAllocationTerminal,
} from "./allocation-lifecycle-commit";

function allocation(status: Allocation["status"]): Allocation {
  return {
    id: "alloc_1",
    bootEpoch: "epoch_1",
    status,
    requirements: [],
    bindings: [],
    allowFallback: false,
    deploymentPolicy: "allow-listed",
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-09-29T00:01:00.000Z",
  } as unknown as Allocation;
}

function operation(status: Operation["status"]): Operation {
  return {
    id: "op_1",
    kind: "allocation",
    allocationId: "alloc_1",
    status,
    ready: false,
    desired: [],
    ensure: [],
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

test("terminal release commits allocation, lifecycle error, and pending operation together", () => {
  const record = allocation("pending");
  const currentOperation = operation("running");

  const result = commitAllocationTerminal({
    allocation: record,
    terminal: "released",
    releasedAt: "2026-09-29T00:00:05.000Z",
    error: { code: "foreground_preempted", message: "preempted" },
  });
  commitAllocationOperationTerminal({
    operation: currentOperation,
    terminal: "released",
    now: () => "2026-09-29T00:00:06.000Z",
  });

  expect(result.wasAdmitted).toBe(true);
  expect(record).toMatchObject({
    status: "released",
    releasedAt: "2026-09-29T00:00:05.000Z",
    error: { code: "foreground_preempted", message: "preempted" },
  });
  expect(currentOperation).toMatchObject({
    status: "cancelled",
    completedAt: "2026-09-29T00:00:06.000Z",
  });
});

test("expiry times out an active operation and leaves terminal history unchanged", () => {
  const waiting = allocation("waiting");
  const pendingOperation = operation("pending");
  const result = commitAllocationTerminal({
    allocation: waiting,
    terminal: "expired",
    releasedAt: "2026-09-29T00:00:10.000Z",
  });
  commitAllocationOperationTerminal({
    operation: pendingOperation,
    terminal: "expired",
    now: () => "2026-09-29T00:00:10.000Z",
  });
  expect(result.wasAdmitted).toBe(false);
  expect(waiting.status).toBe("expired");
  expect(pendingOperation).toMatchObject({ status: "timed_out", completedAt: "2026-09-29T00:00:10.000Z" });

  const terminalOperation = operation("succeeded");
  commitAllocationTerminal({
    allocation: allocation("ready"),
    terminal: "released",
    releasedAt: "2026-09-29T00:00:20.000Z",
  });
  commitAllocationOperationTerminal({
    operation: terminalOperation,
    terminal: "released",
    now: () => "2026-09-29T00:00:20.000Z",
  });
  expect(terminalOperation.status).toBe("succeeded");
  expect(terminalOperation.completedAt).toBeUndefined();
});

test("startup success commits allocation and operation readiness together", () => {
  const record = allocation("pending");
  const currentOperation = operation("running");
  commitAllocationStartupReady({
    allocation: record,
    operation: currentOperation,
    completedAt: "2026-09-29T00:00:07.000Z",
  });
  expect(record.status).toBe("ready");
  expect(currentOperation).toMatchObject({
    status: "succeeded",
    ready: true,
    phase: "runtime-ready",
    completedAt: "2026-09-29T00:00:07.000Z",
  });
});

test("startup failure commits matching allocation and operation error state", () => {
  const record = allocation("pending");
  const currentOperation = operation("running");
  const error = { code: "startup_timeout", message: "startup deadline exceeded" };
  commitAllocationStartupFailure({
    allocation: record,
    operation: currentOperation,
    terminal: "timed_out",
    error,
    completedAt: "2026-09-29T00:00:08.000Z",
  });
  expect(record).toMatchObject({ status: "failed", error });
  expect(currentOperation).toMatchObject({
    status: "timed_out",
    ready: false,
    error,
    completedAt: "2026-09-29T00:00:08.000Z",
  });
});
