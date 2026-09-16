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

test("execution gate promotes higher priorities after active work releases", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const queuedPolicy = { ...policy, maxQueuedRequests: 3, queueTimeoutMs: 1_000 };
  const releaseActive = await gate.acquire("runtime", queuedPolicy, signal, 1_000);
  const contextStill = gate.acquire("runtime", queuedPolicy, signal, 1_000)
    .then((release) => ({ name: "contextstill", release }));
  const nightWorker = gate.acquire("runtime", queuedPolicy, signal, 2_000)
    .then((release) => ({ name: "nightworker", release }));
  const saaa = gate.acquire("runtime", queuedPolicy, signal, 3_000)
    .then((release) => ({ name: "saaa", release }));

  releaseActive();
  const first = await Promise.race([contextStill, nightWorker, saaa]);
  expect(first.name).toBe("saaa");
  first.release();
  const second = await Promise.race([contextStill, nightWorker]);
  expect(second.name).toBe("nightworker");
  second.release();
  const third = await contextStill;
  expect(third.name).toBe("contextstill");
  third.release();
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

test("semantic probes acquire immediately and never join the request queue", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const release = gate.tryAcquire("runtime", policy, signal);
  expect(release).toBeFunction();
  expect(gate.tryAcquire("runtime", policy, signal)).toBeUndefined();
  expect(gate.snapshot("runtime")).toEqual({ active: 1, queued: 0 });
  release!();
});

test("runtime quarantine rejects queued and new work until stop confirmation clears it", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const release = await gate.acquire("runtime", policy, signal);
  const queued = gate.acquire("runtime", policy, signal);
  gate.quarantineRuntime("runtime");
  await expect(queued).rejects.toMatchObject({ code: "runtime_quarantined" });
  expect(gate.isRuntimeQuarantined("runtime")).toBeTrue();
  expect(gate.tryAcquire("runtime", policy, signal)).toBeUndefined();
  await expect(gate.acquire("runtime", policy, signal)).rejects.toMatchObject({
    code: "runtime_quarantined",
  });
  release();
  gate.clearRuntimeQuarantine("runtime");
  expect(gate.isRuntimeQuarantined("runtime")).toBeFalse();
  const releaseAfterConfirmation = await gate.acquire("runtime", policy, signal);
  releaseAfterConfirmation();
});
