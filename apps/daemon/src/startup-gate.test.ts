import { expect, test } from "bun:test";
import { StartupGate } from "./startup-gate";

test("cold loads serialize and cancelled waiters do not stall the next load", async () => {
  const gate = new StartupGate();
  const release = await gate.acquire();
  const cancel = new AbortController();
  const cancelled = gate.acquire(cancel.signal);
  cancel.abort(new Error("cancelled"));
  await expect(cancelled).rejects.toThrow("cancelled");
  let loaded = false;
  const next = gate.run(async () => { loaded = true; });
  await Promise.resolve(); expect(loaded).toBe(false);
  release(); release(); await next; expect(loaded).toBe(true);
});

test("throwing loads release the gate; shutdown rejects queued and future loads", async () => {
  const gate = new StartupGate();
  await expect(gate.run(async () => { throw new Error("load failed"); })).rejects.toThrow("load failed");
  const release = await gate.acquire();
  const queued = gate.acquire();
  gate.close(); release(); await expect(queued).rejects.toThrow("closed");
  await expect(gate.acquire()).rejects.toThrow("closed");
  const abort = new AbortController(); abort.abort(new Error("aborted"));
  expect(() => gate.acquire(abort.signal)).toThrow("aborted");
});
