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

test("exclusive execution drains active work and blocks every runtime until release", async () => {
  const gate = new ExecutionGate();
  const signal = new AbortController().signal;
  const roomyPolicy = { ...policy, queueTimeoutMs: 1_000 };
  const releaseActive = await gate.acquire("worker", roomyPolicy, signal);
  const queued = gate.acquire("worker", roomyPolicy, signal);
  const exclusive = gate.acquireExclusive("resident", roomyPolicy, signal, 3_000);

  await expect(gate.acquire("other", roomyPolicy, signal)).rejects.toMatchObject({
    code: "exclusive_execution",
  });
  expect(gate.tryAcquire("probe", roomyPolicy, signal)).toBeUndefined();
  expect(gate.totals()).toEqual({ active: 1, queued: 2 });

  releaseActive();
  const releaseExclusive = await exclusive;
  expect(gate.snapshot("resident")).toEqual({ active: 1, queued: 0 });
  expect(gate.snapshot("worker")).toEqual({ active: 0, queued: 1 });
  releaseExclusive();

  const releaseQueued = await queued;
  expect(gate.snapshot("worker")).toEqual({ active: 1, queued: 0 });
  releaseQueued();
  expect(gate.totals()).toEqual({ active: 0, queued: 0 });
});

test("a queued main request leaves both subagent lanes available and cancellation preserves active work", async () => {
  const gate = new ExecutionGate(), signal = new AbortController().signal;
  const p = { maxConcurrentRequests: 3, maxQueuedRequests: 4, queueTimeoutMs: 1000 };
  const main = await gate.acquirePartition("runtime", "200000", 1, p, signal);
  const cancelled = new AbortController();
  const waitingMain = gate.acquirePartition("runtime", "200000", 1, p, cancelled.signal);
  const sub1 = await gate.acquirePartition("runtime", "131072", 2, p, signal);
  const sub2 = await gate.acquirePartition("runtime", "131072", 2, p, signal);
  expect(gate.snapshot("runtime").active).toBe(3);
  cancelled.abort(); await expect(waitingMain).rejects.toMatchObject({ code: "request_cancelled" });
  main(); main(); sub1(); sub2();
  expect(gate.snapshot("runtime").active).toBe(0);
  const again = await gate.acquirePartition("runtime", "200000", 1, p, signal); again();
});

test("drain and quarantine reach queued partitions without interrupting active requests", async () => {
  const gate = new ExecutionGate(), signal = new AbortController().signal;
  const p = { maxConcurrentRequests: 3, maxQueuedRequests: 4, queueTimeoutMs: 1000 };
  const main = await gate.acquirePartition("runtime", "main", 1, p, signal);
  const pending = gate.acquirePartition("runtime", "main", 1, p, signal);
  gate.quarantineRuntime("runtime"); await expect(pending).rejects.toMatchObject({ code: "runtime_quarantined" });
  await expect(gate.acquirePartition("runtime", "sub", 2, p, signal)).rejects.toMatchObject({ code: "runtime_quarantined" });
  gate.clearRuntimeQuarantine("runtime"); main();
  const next = await gate.acquirePartition("runtime", "main", 1, p, signal);
  const waiting = gate.acquirePartition("runtime", "main", 1, p, signal);
  gate.beginDrain(); await expect(waiting).rejects.toMatchObject({ code: "draining" });
  expect(gate.snapshot("runtime").active).toBe(1); next();
  await expect(gate.acquirePartition("runtime", "main", 1, p, signal)).rejects.toMatchObject({ code: "draining" });
});
