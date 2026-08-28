import type { RuntimeDefinition, ServiceState } from "@larm/core";

export class LifecycleError extends Error {
  constructor(
    readonly code: "resident_protected" | "start_failed" | "stop_failed" | "access_denied",
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

export interface RuntimeBackend {
  list(): Promise<RuntimeInstance[]>;
  health(runtimeId: string): Promise<RuntimeHealth>;
  ensure(runtime: RuntimeDefinition): Promise<RuntimeInstance>;
  stop(runtimeId: string): Promise<void>;
}
