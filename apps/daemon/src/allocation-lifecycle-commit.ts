import { admittedAllocation, type Allocation } from "@larm/core";
import type { Operation } from "./controller";

export function commitAllocationTerminal(input: {
  allocation: Allocation;
  terminal: "released" | "expired";
  releasedAt: string;
  error?: { code: string; message: string };
}): { wasAdmitted: boolean } {
  const wasAdmitted = admittedAllocation(input.allocation.status);
  input.allocation.status = input.terminal;
  input.allocation.releasedAt = input.releasedAt;
  if (input.error) input.allocation.error = input.error;

  return { wasAdmitted };
}

export function commitAllocationOperationTerminal(input: {
  operation?: Operation;
  terminal: "released" | "expired";
  now: () => string;
}): void {
  const operation = input.operation;
  if (operation && (operation.status === "pending" || operation.status === "running")) {
    operation.status = input.terminal === "expired" ? "timed_out" : "cancelled";
    operation.completedAt = input.now();
  }
}

export function commitAllocationStartupReady(input: {
  allocation: Allocation;
  operation: Operation;
  completedAt: string;
}): void {
  input.allocation.status = "ready";
  input.operation.status = "succeeded";
  input.operation.ready = true;
  input.operation.phase = "runtime-ready";
  input.operation.completedAt = input.completedAt;
}

export function commitAllocationStartupFailure(input: {
  allocation: Allocation;
  operation: Operation;
  terminal: "failed" | "timed_out";
  error: { code: string; message: string };
  completedAt: string;
}): void {
  input.allocation.status = "failed";
  input.allocation.error = input.error;
  input.operation.status = input.terminal;
  input.operation.ready = false;
  input.operation.error = input.error;
  input.operation.completedAt = input.completedAt;
}
