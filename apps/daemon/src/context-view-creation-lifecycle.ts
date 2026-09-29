import type {
  ActiveContextView,
  Allocation,
  ContextDescriptor,
  ContextOperation,
  ContextViewRequest,
  Registry,
  RuntimeReleaseDefinition,
} from "@larm/core";
import type { ContextRuntimeStatus } from "./context-controller-types";
import { ContextControllerError } from "./context-controller-errors";
import { planContextView } from "./context-view-planner";
import { commitContextViewCreation } from "./context-view-commit";
import { publicContextView } from "./context-projection";

const SCOPE = "/v1/context-views";

export class ContextViewCreationLifecycle {
  constructor(private readonly dependencies: {
    registry: Registry;
    descriptors: Map<string, ContextDescriptor>;
    views: Map<string, ActiveContextView>;
    operations: Map<string, ContextOperation>;
    getAllocation: (allocationId: string) => Allocation | undefined;
    getRelease: (releaseId: string) => RuntimeReleaseDefinition | undefined;
    getActivation: (runtime: string) => ContextRuntimeStatus;
    now: () => number;
    isoNow: () => string;
    createViewId: () => string;
    createOperationId: () => string;
    hash: (value: unknown) => string;
    replay: <T>(principal: string, scope: string, key: string, requestHash: string) => T | undefined;
    assertIdempotencyCapacity: () => void;
    remember: <T>(principal: string, scope: string, key: string, requestHash: string, result: T) => void;
    emit: (runtime: string) => void;
  }) {}

  create(
    request: ContextViewRequest,
    principal: string,
    idempotencyKey: string,
  ): { view: ReturnType<typeof publicContextView>; replay: boolean } {
    const d = this.dependencies;
    const requestHash = d.hash({
      operation: "create-view",
      principal,
      request: {
        ...request,
        items: [...request.items].sort((left, right) =>
          compareCanonicalText(left.contextId, right.contextId)
          || compareCanonicalText(left.version, right.version)
        ),
      },
    });
    const replay = d.replay<{ view: ReturnType<typeof publicContextView> }>(
      principal,
      SCOPE,
      idempotencyKey,
      requestHash,
    );
    if (replay) return { ...replay, replay: true };
    d.assertIdempotencyCapacity();
    const allocation = d.getAllocation(request.allocationId);
    if (!allocation || allocation.status !== "ready") {
      throw new ContextControllerError(409, "no_eligible_runtime_active", "allocation is not ready");
    }
    const runtime = d.registry.runtimes.find((candidate) => candidate.id === request.runtime);
    const view = planContextView({
      request,
      principal,
      allocation,
      runtime,
      getRelease: d.getRelease,
      getActivation: () => d.getActivation(request.runtime),
      descriptors: d.descriptors.values(),
      getDescriptor: (owner, contextId, version) =>
        d.descriptors.get(descriptorKey(owner, contextId, version)),
      now: d.now,
      createViewId: d.createViewId,
      createOperationId: d.createOperationId,
      createdAt: d.isoNow,
    });
    const result = commitContextViewCreation({
      view,
      principal,
      idempotencyKeyDigest: d.hash(idempotencyKey),
      views: d.views,
      operations: d.operations,
      project: publicContextView,
      remember: (value) => d.remember(principal, SCOPE, idempotencyKey, requestHash, value),
      emit: d.emit,
    });
    return { ...result, replay: false };
  }
}

function descriptorKey(principal: string, id: string, version: string): string {
  return `${principal}\0${id}\0${version}`;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
