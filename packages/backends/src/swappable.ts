import type { RuntimeDefinition } from "@larm/core";
import type { RuntimeBackend, RuntimeHealth, RuntimeInstance } from "./types";

export class SwappableRuntimeBackend implements RuntimeBackend {
  constructor(private current: RuntimeBackend) {}

  replace(next: RuntimeBackend): RuntimeBackend {
    const previous = this.current;
    this.current = next;
    return previous;
  }

  list(): Promise<RuntimeInstance[]> {
    return this.current.list();
  }

  health(runtimeId: string): Promise<RuntimeHealth> {
    return this.current.health(runtimeId);
  }

  ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeInstance> {
    return this.current.ensure(runtime, signal);
  }

  stop(runtimeId: string): Promise<void> {
    return this.current.stop(runtimeId);
  }
}
