import {
  bindContextViewDigest,
  type ActiveContextView,
  type ContextDescriptor,
  type ContextPlanItem,
  type ContextViewOmission,
} from "@larm/core";

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type PersonalStateInvalidationInput = {
  principal: string;
  contextIds: string[];
  sourceHandles: string[];
  sourceDigests?: string[];
  viewIds?: string[];
  attemptIds?: string[];
};

export type PersonalStateInvalidationPlan = {
  descriptors: ContextDescriptor[];
  viewIds: string[];
  sourceDigests: string[];
};

export async function invalidatePersonalStateViews(input: {
  request: PersonalStateInvalidationInput;
  descriptors: Map<string, ContextDescriptor>;
  views: Map<string, ActiveContextView>;
  materializingViews: Set<string>;
  persist: () => Promise<void>;
  updateOperation: (operationId: string, state: "cancelled", outcome: "personal_state_forgotten") => void;
  onPlanned?: (plan: PersonalStateInvalidationPlan) => Promise<{ viewIds?: string[] } | void>;
}): Promise<PersonalStateInvalidationPlan> {
  const request = input.request;
  const contextIds = new Set(request.contextIds);
  const sourceHandles = new Set(request.sourceHandles);
  const removed: Array<{ key: string; descriptor: ContextDescriptor }> = [];
  for (const [key, descriptor] of input.descriptors) {
    if (
      descriptor.principal === request.principal
      && (contextIds.has(descriptor.id) || sourceHandles.has(descriptor.sourceHandle))
    ) {
      removed.push({ key, descriptor });
      sourceHandles.add(descriptor.sourceHandle);
    }
  }
  const sourceDigests = new Set([
    ...removed.map(({ descriptor }) => descriptor.sourceDigest),
    ...(request.sourceDigests ?? []),
  ]);
  const requestedViewIds = new Set(request.viewIds ?? []);
  const affectedViews = [...input.views.values()].filter((view) =>
    view.principal === request.principal
    && (
      requestedViewIds.has(view.id)
      || view.orderedItems.some((item) =>
        contextIds.has(item.contextId) || sourceDigests.has(item.sourceDigest)
      )
    )
  );
  let viewIds = [...new Set([
    ...requestedViewIds,
    ...affectedViews.map((view) => view.id),
  ])];
  let plan: PersonalStateInvalidationPlan = {
    descriptors: removed.map(({ descriptor }) => descriptor),
    viewIds,
    sourceDigests: [...sourceDigests],
  };
  const additions = await input.onPlanned?.(plan);
  if (additions?.viewIds) {
    viewIds = [...new Set([...viewIds, ...additions.viewIds])];
    plan = { ...plan, viewIds };
    const affectedViewIds = new Set(affectedViews.map((view) => view.id));
    for (const viewId of additions.viewIds) {
      const view = input.views.get(viewId);
      if (view?.principal === request.principal && !affectedViewIds.has(view.id)) {
        affectedViews.push(view);
        affectedViewIds.add(view.id);
      }
    }
  }
  if (removed.length > 0) {
    for (const { key } of removed) input.descriptors.delete(key);
    try {
      await input.persist();
    } catch (error) {
      for (const { key, descriptor } of removed) input.descriptors.set(key, descriptor);
      throw error;
    }
  }
  for (const view of affectedViews) {
    view.state = "invalid";
    input.materializingViews.delete(view.id);
    input.updateOperation(view.operationId, "cancelled", "personal_state_forgotten");
  }
  return plan;
}

export function bindPersonalStateViewData(input: {
  view: ActiveContextView;
  requestDigest: string;
  dataEpoch: number;
  actualInputTokens: number;
  selectedItems: ContextPlanItem[];
  omitted: ContextViewOmission[];
}): ActiveContextView {
  const view = input.view;
  view.requestDigest = input.requestDigest;
  view.dataEpoch = input.dataEpoch;
  view.canonicalizationVersion = "context-view-v2";
  view.viewDigest = bindContextViewDigest(view.viewDigest, input.requestDigest);
  view.tokenCount = input.actualInputTokens;
  const selected = new Map(input.selectedItems.map((item) => [
    `${item.contextId}\0${item.version}`,
    item,
  ]));
  view.orderedItems = view.orderedItems.map((item) => {
    const original = selected.get(`${item.contextId}\0${item.version}`);
    return original ? { ...item, required: original.required, utility: original.utility } : item;
  });
  view.omitted = [...view.omitted, ...input.omitted].sort((left, right) =>
    compareCanonicalText(left.contextId, right.contextId)
    || compareCanonicalText(left.version, right.version)
    || compareCanonicalText(left.reason, right.reason)
  );
  return view;
}
