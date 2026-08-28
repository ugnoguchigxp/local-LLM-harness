import { expect, test } from "bun:test";
import { ExecutionGate, ExecutionGateError } from "./execution-gate";

const policy = {
  maxConcurrentRequests: 1,
  maxQueuedRequests: 1,
  queueTimeoutMs: 20,
};

test("execution gate is FIFO and never exceeds the runtime policy", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const releaseFirst = await gate.acquire("runtime", policy, signal);
  const second = gate.acquire("runtime", policy, signal);
  expect(gate.snapshot("runtime")).toEqual({ active: 1, queued: 1 });
  releaseFirst();
  const releaseSecond = await second;
  expect(gate.snapshot("runtime")).toEqual({ active: 1, queued: 0 });
  releaseSecond();
  expect(gate.snapshot("runtime")).toEqual({ active: 0, queued: 0 });
});

test("execution gate rejects a full queue and times out bounded waits", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const release = await gate.acquire("runtime", policy, signal);
  const queued = gate.acquire("runtime", policy, signal);
  await expect(gate.acquire("runtime", policy, signal)).rejects.toMatchObject({
    code: "queue_full",
  });
  await expect(queued).rejects.toMatchObject({ code: "queue_timeout" });
  release();
});

test("execution gate cancels queued callers and drain does not interrupt active work", async () => {
  const gate = new ExecutionGate();
  const activeSignal = new AbortController().signal;
  const queuedAbort = new AbortController();
  const release = await gate.acquire("runtime", policy, activeSignal);
  const queued = gate.acquire("runtime", policy, queuedAbort.signal);
  queuedAbort.abort();
  await expect(queued).rejects.toBeInstanceOf(ExecutionGateError);
  gate.beginDrain();
  expect(gate.snapshot("runtime").active).toBe(1);
  await expect(gate.acquire("runtime", policy, activeSignal)).rejects.toMatchObject({
    code: "draining",
  });
  release();
});
