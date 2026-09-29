import { describe, expect, test } from "bun:test";
import { LifecycleError, type RuntimeBackend } from "@larm/backends";
import type { Registry } from "@larm/core";
import type { Observer } from "./observer";
import type { Operation } from "./controller";
import { runLegacyPrepareOperation } from "./legacy-prepare-operation";

const registry = { runtimes: [{ id: "runtime" }] } as unknown as Registry;

function operation(): Operation {
  return {
    id: "operation",
    kind: "prepare",
    status: "pending",
    ready: false,
    desired: ["llm.general"],
    ensure: ["runtime"],
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const currentOperation = operation();
  const abort = new AbortController();
  const events: string[] = [];
  const input = {
    operation: currentOperation,
    abort,
    registry,
    backend: { ensure: async () => { events.push("ensure"); } } as unknown as RuntimeBackend,
    observer: { tick: async () => { events.push("tick"); } } as unknown as Pick<Observer, "tick">,
    isoNow: () => "2026-09-29T00:00:01.000Z",
    deleteAbortedOperation: (id: string) => events.push(`delete:${id}`),
    clearOperationAbort: (id: string) => events.push(`clear:${id}`),
    pruneHistory: () => events.push("prune"),
    ...overrides,
  };
  return { input, currentOperation, abort, events };
}

describe("legacy prepare runtime operation", () => {
  test("ensures each planned runtime and commits success before cleanup", async () => {
    const state = fixture();
    await runLegacyPrepareOperation(state.input as never);
    expect(state.currentOperation).toMatchObject({
      status: "succeeded",
      ready: true,
      completedAt: "2026-09-29T00:00:01.000Z",
    });
    expect(state.events).toEqual(["ensure", "tick", "clear:operation", "prune"]);
  });

  test("a pre-aborted operation records cancellation and drops its abort entry", async () => {
    const state = fixture();
    state.abort.abort(new Error("lease was released"));
    await runLegacyPrepareOperation(state.input as never);
    expect(state.currentOperation).toMatchObject({
      status: "cancelled",
      ready: false,
      error: { code: "operation_cancelled", message: "lease was released" },
    });
    expect(state.events).toEqual(["delete:operation", "prune"]);
  });

  test("preserves backend lifecycle errors and clears the running operation", async () => {
    const state = fixture({
      backend: {
        ensure: async () => { throw new LifecycleError("revision_conflict", "runtime changed"); },
      } as unknown as RuntimeBackend,
    });
    await runLegacyPrepareOperation(state.input as never);
    expect(state.currentOperation).toMatchObject({
      status: "failed",
      ready: false,
      error: { code: "revision_conflict", message: "runtime changed" },
    });
    expect(state.events).toEqual(["clear:operation", "prune"]);
  });

  test("cancellation during ensure wins over the backend result", async () => {
    const state = fixture({
      backend: {
        ensure: async (_runtime: unknown, signal: AbortSignal) => {
          state.abort.abort(new Error("cancelled during start"));
          signal.throwIfAborted();
        },
      } as unknown as RuntimeBackend,
    });
    await runLegacyPrepareOperation(state.input as never);
    expect(state.currentOperation).toMatchObject({
      status: "cancelled",
      error: { code: "operation_cancelled", message: "cancelled during start" },
    });
    expect(state.events).toEqual(["clear:operation", "prune"]);
  });
});
