import type { ActiveContextView } from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";

export function assertContextViewMaterializable(input: {
  view: ActiveContextView | undefined;
  principal: string;
  allocationId: string;
  runtime: string;
  release: string;
  isMaterializing: boolean;
  now: () => number;
  getActivation: () => { state: string; leaseEpoch: number; release?: string };
}): ActiveContextView {
  const view = input.view;
  if (!view || view.principal !== input.principal) {
    throw new ContextControllerError(404, "context_not_found", "context view was not found");
  }
  if (view.state === "consumed") {
    throw new ContextControllerError(409, "context_view_consumed", "context view was already consumed");
  }
  if (input.isMaterializing) {
    throw new ContextControllerError(429, "context_operation_busy", "context view is being consumed");
  }
  if (view.state !== "ready" || Date.parse(view.expiresAt) <= input.now()) {
    throw new ContextControllerError(410, "context_view_stale", "context view is no longer valid");
  }
  const activation = input.getActivation();
  if (
    (activation.state !== "ACTIVE" && activation.state !== "BUSY")
    || activation.leaseEpoch !== view.leaseEpoch
    || activation.release !== view.release
    || view.allocationId !== input.allocationId
    || view.runtime !== input.runtime
    || view.release !== input.release
  ) {
    view.state = "invalid";
    throw new ContextControllerError(409, "context_view_stale", "context view binding changed");
  }
  return view;
}
