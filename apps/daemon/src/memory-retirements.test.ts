import { expect, test } from "bun:test";
import { MemoryRetirements } from "./memory-retirements";

test("cancelling a queued retirement releases its reservation before a slow stop finishes", async () => {
  const retirements = new MemoryRetirements();
  const entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const abort = new AbortController();
  const released: string[] = [];
  let secondStops = 0;
  try {
    const first = retirements.run({ runtimeId: "first", timeoutMs: 5, retryMs: 25,
      eligible: () => true, busy: () => false,
      retire: async () => { entered.resolve(); await stopped.promise; return true; },
      release: () => { released.push("first"); },
    });
    await entered.promise;
    const second = retirements.run({ runtimeId: "second", timeoutMs: 5, retryMs: 25,
      signal: abort.signal, eligible: () => true, busy: () => false,
      retire: async () => { secondStops++; return true; },
      release: () => { released.push("second"); },
    });
    abort.abort(new Error("cancelled"));
    expect(released).toEqual(["second"]);
    expect(await second).toBe(false);
    stopped.resolve(); await first; await retirements.flush();
    expect(secondStops).toBe(0);
    expect(released).toEqual(["second", "first"]);
  } finally { stopped.resolve(); retirements.close(); await retirements.flush(); }
});
