import type { ActiveContextView } from "@larm/core";

export function publicContextView(view: ActiveContextView) {
  return {
    id: view.id,
    operationId: view.operationId,
    allocationId: view.allocationId,
    runtime: view.runtime,
    release: view.release,
    state: view.state,
    mode: "source-rebuild" as const,
    canonicalizationVersion: view.canonicalizationVersion,
    ...(view.requestDigest ? { requestDigest: view.requestDigest } : {}),
    ...(view.dataEpoch !== undefined ? { dataEpoch: view.dataEpoch } : {}),
    tokenCount: view.tokenCount,
    inputBudgetTokens: view.inputBudgetTokens,
    orderedItems: view.orderedItems,
    omitted: view.omitted,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
  };
}
