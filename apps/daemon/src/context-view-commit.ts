import type { ActiveContextView, ContextOperation } from "@larm/core";

export function commitContextViewCreation<T>(input: {
  view: ActiveContextView;
  principal: string;
  idempotencyKeyDigest: string;
  views: Map<string, ActiveContextView>;
  operations: Map<string, ContextOperation>;
  project: (view: ActiveContextView) => T;
  remember: (result: { view: T }) => void;
  emit: (runtime: string) => void;
}): { view: T } {
  const view = input.view;
  input.views.set(view.id, view);
  const operation: ContextOperation = {
    schemaVersion: 1,
    id: view.operationId,
    principal: input.principal,
    idempotencyKeyDigest: input.idempotencyKeyDigest,
    viewId: view.id,
    fence: view.leaseEpoch,
    mode: "source-rebuild",
    state: "pending",
    deadline: view.expiresAt,
    createdAt: view.createdAt,
    updatedAt: view.createdAt,
  };
  input.operations.set(operation.id, operation);
  const result = { view: input.project(view) };
  input.remember(result);
  input.emit(view.runtime);
  return result;
}
