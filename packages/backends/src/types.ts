import type {
  ProviderInstance,
  ProviderRevision,
  RuntimeDefinition,
  ServiceState,
} from "@larm/core";

export class LifecycleError extends Error {
  constructor(
    readonly code:
      | "resident_protected"
      | "revision_conflict"
      | "start_failed"
      | "stop_failed"
      | "access_denied",
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export type RuntimeHealth = {
  runtimeId: string;
  service: ServiceState;
  listening: boolean;
  healthOk: boolean;
  busy: boolean;
  httpStatus?: number;
  detail?: string;
};

export type RuntimeInstance = RuntimeHealth;

export type ProviderInstanceHealth = ProviderInstance & {
  service: ServiceState;
  listening: boolean;
  healthOk: boolean;
  busy: boolean;
  httpStatus?: number;
  detail?: string;
};

export interface RuntimeBackend {
  list(): Promise<RuntimeInstance[]>;
  health(runtimeId: string): Promise<RuntimeHealth>;
  ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeInstance>;
  stop(runtimeId: string): Promise<void>;
  /** Instance-aware lifecycle. Legacy methods remain during catalog migration. */
  listInstances?(): Promise<ProviderInstanceHealth[]>;
  ensureInstance?(
    revision: ProviderRevision,
    runtime: RuntimeDefinition,
    signal?: AbortSignal,
  ): Promise<ProviderInstance>;
  healthInstance?(instanceId: string): Promise<ProviderInstanceHealth>;
  drainInstance?(instanceId: string, signal?: AbortSignal): Promise<void>;
  stopInstance?(instanceId: string): Promise<void>;
}
