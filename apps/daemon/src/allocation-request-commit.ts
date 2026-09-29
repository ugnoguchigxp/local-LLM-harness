import {
  type Allocation,
  type AllocationRequest,
  type ProviderInstance,
} from "@larm/core";
import type { AllocationRequestAdmission } from "./allocation-request-admission";
import type { Operation } from "./controller";

type AdmittedRequest = Extract<AllocationRequestAdmission, { ok: true }>;

export type AllocationRequestCommitPort = {
  allocationId: string;
  bootEpoch: string;
  catalogRevision?: string;
  request: AllocationRequest;
  admission: AdmittedRequest;
  now: number;
  storeAllocation: (allocation: Allocation) => void;
  retainExisting: (
    runtimeId: string,
    allocationId: string,
    providerRevision?: string,
  ) => ProviderInstance | undefined;
  requiresInstanceTracking: boolean;
  registerLifecycleAbort: (allocationId: string) => void;
  emitCreated: (allocation: Allocation) => void;
  emitReady: (allocation: Allocation) => void;
  scheduleExpiry: (allocation: Allocation) => void;
  cancelIdle: () => void;
  startupDeadline: (allocation: Allocation) => number;
  createOperationId: () => string;
  storeOperation: (operation: Operation) => void;
  enqueueWaitingPromotion: () => void;
  enqueueStartup: (allocation: Allocation, operation: Operation, deadline: number) => void;
  pruneHistory: () => void;
};

export function commitAllocationRequest(input: AllocationRequestCommitPort):
  | { status: 200; body: Allocation }
  | { status: 202; body: Allocation } {
  const { admission, request } = input;
  const { capabilities, bindings, runtimeIds, waiting } = admission;
  const allocation: Allocation = {
    id: input.allocationId,
    bootEpoch: input.bootEpoch,
    catalogRevision: input.catalogRevision,
    client: request.client,
    status: waiting
      ? "waiting"
      : request.deploymentPolicy === "existing-only"
        && bindings.every((binding) => binding.status === "HOT" || binding.status === "BUSY")
      ? "ready"
      : "pending",
    requirements: request.requirements,
    bindings,
    allowFallback: request.allowFallback,
    deploymentPolicy: request.deploymentPolicy,
    priority: request.priority,
    capacityPolicy: request.capacityPolicy,
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + request.ttlSeconds * 1_000).toISOString(),
  };

  input.storeAllocation(allocation);
  for (const binding of allocation.bindings) {
    const instance = input.retainExisting(binding.runtime, allocation.id, binding.providerRevision);
    if (!instance) continue;
    binding.instanceId = instance.id;
    binding.instanceGeneration = instance.generation;
    binding.endpoint = instance.endpoint;
  }
  if (
    allocation.status === "ready"
    && input.requiresInstanceTracking
    && allocation.bindings.some((binding) => binding.instanceId === undefined)
  ) {
    allocation.status = "pending";
  }
  input.registerLifecycleAbort(allocation.id);
  input.emitCreated(allocation);
  input.scheduleExpiry(allocation);
  input.cancelIdle();

  if (allocation.status === "ready") {
    input.emitReady(allocation);
    input.pruneHistory();
    return { status: 200, body: allocation };
  }

  const deadline = allocation.status === "waiting"
    ? Date.parse(allocation.expiresAt)
    : input.startupDeadline(allocation);
  const operation: Operation = {
    id: input.createOperationId(),
    kind: "allocation",
    allocationId: allocation.id,
    status: "pending",
    ready: false,
    desired: [...capabilities].sort(),
    ensure: runtimeIds,
    createdAt: new Date(input.now).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    phase: allocation.status === "waiting" ? "waiting-for-capacity" : "scheduled",
  };
  allocation.operationId = operation.id;
  input.storeOperation(operation);
  if (allocation.status === "waiting") {
    input.enqueueWaitingPromotion();
  } else {
    input.enqueueStartup(allocation, operation, deadline);
  }
  input.pruneHistory();
  return { status: 202, body: allocation };
}
