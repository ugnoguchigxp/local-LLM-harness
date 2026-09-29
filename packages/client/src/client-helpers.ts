import type { ControlOperation, PublicAgentConnection, PublicAllocation } from "@larm/core";
import { LarmApiError } from "./errors";

export function createIdempotencyKey(random?: () => string): string {
  return `client_${(random ?? (() => crypto.randomUUID()))()}`;
}

export function allocationTimeout(allocation: PublicAllocation): LarmApiError {
  return new LarmApiError(
    408,
    "allocation_timeout",
    `allocation ${allocation.id} did not become ready before the client deadline`,
    allocation,
  );
}

export function operationTimeout(id: string, operation?: ControlOperation): LarmApiError {
  return new LarmApiError(
    408,
    "operation_timeout",
    `operation ${id} did not complete before the client deadline`,
    operation,
  );
}

export function connectionTimeout(connection: PublicAgentConnection): LarmApiError {
  return new LarmApiError(
    408,
    "connection_timeout",
    `connection ${connection.id} did not become ready before the client deadline`,
    connection,
  );
}

export function validatePollingOptions(timeoutMs: number, pollIntervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("poll timeoutMs must be a nonnegative finite number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("pollIntervalMs must be a nonnegative finite number");
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForOperation(input: {
  operation: ControlOperation | string;
  signal?: AbortSignal;
  pollIntervalMs: number;
  timeoutMs: number;
  getOperation: (id: string, signal: AbortSignal | undefined, timeoutMs: number) => Promise<ControlOperation>;
}): Promise<ControlOperation> {
  validatePollingOptions(input.timeoutMs, input.pollIntervalMs);
  const deadline = Date.now() + input.timeoutMs;
  let current: ControlOperation;
  if (typeof input.operation === "string") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw operationTimeout(input.operation);
    try {
      current = await input.getOperation(input.operation, input.signal, remainingMs);
    } catch (error) {
      if (Date.now() >= deadline) throw operationTimeout(input.operation);
      throw error;
    }
  } else {
    current = input.operation;
  }
  while (current.status === "pending" || current.status === "running") {
    if (Date.now() >= deadline) throw operationTimeout(current.id, current);
    await delay(
      Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now())),
      input.signal,
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw operationTimeout(current.id, current);
    try {
      current = await input.getOperation(current.id, input.signal, remainingMs);
    } catch (error) {
      if (Date.now() >= deadline) throw operationTimeout(current.id, current);
      throw error;
    }
  }
  if (current.status !== "succeeded") {
    throw new LarmApiError(
      current.status === "timed_out" ? 408 : 409,
      current.error?.code ?? `operation_${current.status}`,
      current.error?.message ?? `operation ${current.id} ended as ${current.status}`,
      current,
    );
  }
  return current;
}
