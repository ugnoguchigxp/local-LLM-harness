import type { ContextOperation } from "@larm/core";

export function commitContextOperation(input: {
  operations: ReadonlyMap<string, ContextOperation>;
  id: string;
  state: ContextOperation["state"];
  outcome?: string;
  now: number;
  emit: (name: string, labels: Record<string, string>, value?: number) => void;
}): void {
  const operation = input.operations.get(input.id);
  if (!operation) return;

  const previousState = operation.state;
  const previousUpdatedAt = Date.parse(operation.updatedAt);
  operation.state = input.state;
  operation.updatedAt = new Date(input.now).toISOString();
  if (input.outcome) operation.outcome = input.outcome;

  const wasTerminal = previousState === "succeeded"
    || previousState === "failed"
    || previousState === "cancelled";
  const isTerminal = input.state === "succeeded"
    || input.state === "failed"
    || input.state === "cancelled";
  if (!isTerminal || wasTerminal) return;

  input.emit("context_operations", { mode: operation.mode, outcome: input.outcome ?? input.state });
  if (previousState === "running" && Number.isFinite(previousUpdatedAt)) {
    input.emit(
      "context_materialization_seconds",
      { mode: operation.mode },
      Math.max(0, (input.now - previousUpdatedAt) / 1000),
    );
  }
}
