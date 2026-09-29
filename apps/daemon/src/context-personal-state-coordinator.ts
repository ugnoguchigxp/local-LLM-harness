import type {
  ActiveContextView,
  ContextDescriptor,
  ContextPlanItem,
  ContextViewOmission,
} from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";
import {
  bindPersonalStateViewData,
  invalidatePersonalStateViews,
  type PersonalStateInvalidationPlan,
} from "./context-personal-state-bridge";
import { publicContextView } from "./context-projection";

export type ContextPersonalStateInvalidationInput = {
  principal: string;
  contextIds: string[];
  sourceHandles: string[];
  sourceDigests?: string[];
  viewIds?: string[];
  attemptIds?: string[];
};

export type ContextPersonalStateCoordinatorOptions = {
  descriptors: Map<string, ContextDescriptor>;
  views: Map<string, ActiveContextView>;
  materializingViews: Set<string>;
  initialize: () => Promise<void>;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>;
  persist: () => Promise<void>;
  updateOperation: (
    operationId: string,
    state: "cancelled",
    outcome: "personal_state_forgotten",
  ) => void;
};

export class ContextPersonalStateCoordinator {
  constructor(private readonly options: ContextPersonalStateCoordinatorOptions) {}

  async bindView(input: {
    principal: string;
    viewId: string;
    requestDigest: string;
    dataEpoch: number;
    actualInputTokens: number;
    selectedItems: ContextPlanItem[];
    omitted: ContextViewOmission[];
  }): Promise<ReturnType<typeof publicContextView>> {
    await this.options.initialize();
    return await this.options.serialized(async () => {
      const view = this.options.views.get(input.viewId);
      if (!view || view.principal !== input.principal || view.state !== "ready") {
        throw new ContextControllerError(404, "context_not_found", "context view was not found");
      }
      bindPersonalStateViewData({ view, ...input });
      return publicContextView(view);
    });
  }

  viewBinding(principal: string, viewId: string): {
    requestDigest: string;
    dataEpoch: number;
    sourceDigests: string[];
  } | undefined {
    const view = this.options.views.get(viewId);
    if (!view || view.principal !== principal || !view.requestDigest || view.dataEpoch === undefined) {
      return undefined;
    }
    return {
      requestDigest: view.requestDigest,
      dataEpoch: view.dataEpoch,
      sourceDigests: view.orderedItems.map((item) => item.sourceDigest),
    };
  }

  getView(principal: string, viewId: string): ReturnType<typeof publicContextView> | undefined {
    const view = this.options.views.get(viewId);
    return view?.principal === principal && view.state === "ready" ? publicContextView(view) : undefined;
  }

  async invalidate(
    input: ContextPersonalStateInvalidationInput,
    onPlanned?: (
      plan: PersonalStateInvalidationPlan,
    ) => Promise<{ viewIds?: string[] } | void>,
  ): Promise<PersonalStateInvalidationPlan> {
    await this.options.initialize();
    return await this.options.serialized(async () => await invalidatePersonalStateViews({
      request: input,
      descriptors: this.options.descriptors,
      views: this.options.views,
      materializingViews: this.options.materializingViews,
      persist: this.options.persist,
      updateOperation: this.options.updateOperation,
      onPlanned,
    }));
  }
}
