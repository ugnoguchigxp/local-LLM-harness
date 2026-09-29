import { expect, test } from "bun:test";
import type { ContextOperation } from "@larm/core";
import { commitContextOperation } from "./context-operation-commit";

function operation(overrides: Partial<ContextOperation> = {}): ContextOperation {
  return {
    schemaVersion: 1,
    id: "ctxop_1",
    principal: "principal",
    idempotencyKeyDigest: "digest",
    viewId: "view_1",
    fence: 1,
    mode: "source-rebuild",
    state: "running",
    deadline: "1970-01-01T00:01:00.000Z",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:04.000Z",
    ...overrides,
  };
}

test("commits terminal state and emits elapsed materialization time once", () => {
  const current = operation();
  const operations = new Map([[current.id, current]]);
  const events: Array<{ name: string; labels: Record<string, string>; value?: number }> = [];
  const emit = (name: string, labels: Record<string, string>, value?: number) =>
    events.push({ name, labels, ...(value === undefined ? {} : { value }) });

  commitContextOperation({ operations, id: current.id, state: "succeeded", outcome: "materialized", now: 9_000, emit });
  commitContextOperation({ operations, id: current.id, state: "failed", outcome: "late_failure", now: 10_000, emit });

  expect(current).toMatchObject({ state: "failed", outcome: "late_failure", updatedAt: "1970-01-01T00:00:10.000Z" });
  expect(events).toEqual([
    { name: "context_operations", labels: { mode: "source-rebuild", outcome: "materialized" } },
    { name: "context_materialization_seconds", labels: { mode: "source-rebuild" }, value: 5 },
  ]);
});

test("updates nonterminal operations without terminal metrics and ignores unknown ids", () => {
  const current = operation({ state: "pending" });
  const events: unknown[] = [];
  const input = {
    operations: new Map([[current.id, current]]),
    state: "running" as const,
    now: 12_000,
    emit: (...args: unknown[]) => events.push(args),
  };

  commitContextOperation({ ...input, id: current.id });
  commitContextOperation({ ...input, id: "missing", state: "cancelled" });

  expect(current.state).toBe("running");
  expect(events).toEqual([]);
});
