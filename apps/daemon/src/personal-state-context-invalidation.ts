import type { ContextDescriptor, ForgetRequest } from "@larm/core";
import type { LocalPersonalStateJournal } from "@larm/backends";
import type { ContextController } from "./context-controller";

type InvalidationState = {
  descriptors: ContextDescriptor[];
  viewIds: string[];
  sourceDigests: string[];
};

export async function invalidatePersonalStateContext(input: {
  context: Pick<ContextController, "invalidatePersonalState">;
  journal: Pick<LocalPersonalStateJournal, "forget" | "viewsForSubject" | "saveForget" | "saveView">;
  principal: string;
  subjectDigest: string;
  forgetId: string;
  request: ForgetRequest;
  sourceHandles: Set<string>;
  initial: InvalidationState;
  nowIso: () => string;
}): Promise<InvalidationState> {
  let invalidated = input.initial;
  const result = await input.context.invalidatePersonalState({
    principal: input.principal,
    contextIds: input.request.contextIds,
    sourceHandles: [...input.sourceHandles],
    sourceDigests: invalidated.sourceDigests,
    viewIds: invalidated.viewIds,
    attemptIds: input.request.attemptIds,
  }, async (plan) => {
    for (const descriptor of plan.descriptors) input.sourceHandles.add(descriptor.sourceHandle);
    const current = await input.journal.forget(input.subjectDigest, input.forgetId);
    if (!current) throw new Error("forget_operation_missing");
    const contextIds = new Set(input.request.contextIds);
    const sourceDigests = new Set([
      ...(current.resolved?.sourceDigests ?? []),
      ...plan.sourceDigests,
    ]);
    const durableViewIds = (await input.journal.viewsForSubject(input.subjectDigest))
      .filter((view) =>
        !view.dependencies
        || view.dependencies.contextIds.some((id) => contextIds.has(id))
        || view.dependencies.sourceDigests.some((digest) => sourceDigests.has(digest))
      )
      .map((view) => view.viewId);
    const resolvedViewIds = [...new Set([
      ...(current.resolved?.viewIds ?? []),
      ...plan.viewIds,
      ...durableViewIds,
    ])].sort();
    await input.journal.saveForget({
      ...current,
      resolved: {
        sourceHandles: [...input.sourceHandles].sort(),
        sourceDigests: [...sourceDigests].sort(),
        viewIds: resolvedViewIds,
      },
      updatedAt: input.nowIso(),
    });
    return { viewIds: resolvedViewIds };
  });

  invalidated = {
    descriptors: result.descriptors,
    viewIds: [...new Set([...invalidated.viewIds, ...result.viewIds])],
    sourceDigests: [...new Set([...invalidated.sourceDigests, ...result.sourceDigests])],
  };
  for (const descriptor of invalidated.descriptors) input.sourceHandles.add(descriptor.sourceHandle);
  const invalidatedIds = new Set(invalidated.viewIds);
  for (const receipt of await input.journal.viewsForSubject(input.subjectDigest)) {
    if (!invalidatedIds.has(receipt.viewId)) continue;
    await input.journal.saveView({
      ...receipt,
      state: "invalid",
      updatedAt: input.nowIso(),
    });
  }
  return invalidated;
}
