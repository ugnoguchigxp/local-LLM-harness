import type { ActiveContextView } from "@larm/core";

type ViewOperationState = "cancelled";

export function invalidateReadyContextViews(
  views: Iterable<ActiveContextView>,
  options: {
    matches?: (view: ActiveContextView) => boolean;
    operationOutcome?: string;
    updateOperation?: (operationId: string, state: ViewOperationState, outcome: string) => void;
  } = {},
): number {
  let invalidated = 0;
  for (const view of views) {
    if (view.state !== "ready" || (options.matches && !options.matches(view))) continue;
    view.state = "invalid";
    invalidated += 1;
    if (options.operationOutcome) {
      options.updateOperation?.(view.operationId, "cancelled", options.operationOutcome);
    }
  }
  return invalidated;
}

export function expireContextView(
  id: string,
  view: ActiveContextView,
  options: {
    updateOperation: (operationId: string, state: ViewOperationState, outcome: string) => void;
    clearMaterializing: (id: string) => void;
    removeView: (id: string) => void;
  },
): void {
  view.state = "expired";
  options.updateOperation(view.operationId, "cancelled", "context_view_expired");
  options.clearMaterializing(id);
  options.removeView(id);
}
