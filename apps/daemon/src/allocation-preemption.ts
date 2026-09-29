import {
  admittedAllocation,
  getRuntime,
  type Allocation,
  type Registry,
} from "@larm/core";

type ProviderSwitchHold = {
  runtime: string;
  priority: number;
  until: number;
};

export type AllocationPreemptionOptions = {
  now?: () => number;
  foregroundPriorityThreshold?: number;
  providerSwitchHoldMs?: number;
  emit?: (name: string, labels: Record<string, string>) => void;
};

export class AllocationPreemption {
  private readonly providerSwitchHolds = new Map<string, ProviderSwitchHold>();

  constructor(
    private readonly registry: Registry,
    private readonly options: AllocationPreemptionOptions = {},
  ) {}

  foregroundPriorityThreshold(): number {
    return this.options.foregroundPriorityThreshold ?? 3_000;
  }

  holdForegroundProviders(allocation: Allocation): void {
    const duration = this.options.providerSwitchHoldMs ?? 300_000;
    if (duration <= 0) return;
    const until = this.now() + duration;
    for (const binding of allocation.bindings) {
      const swapGroup = getRuntime(this.registry, binding.runtime)?.policy.swapGroup;
      if (!swapGroup) continue;
      const current = this.providerSwitchHolds.get(swapGroup);
      const hold: ProviderSwitchHold = {
        runtime: binding.runtime,
        priority: allocation.priority ?? 0,
        until: Math.max(until, current?.until ?? 0),
      };
      this.providerSwitchHolds.set(swapGroup, hold);
      this.options.emit?.("provider_switch_hold_started", {
        swapGroup,
        runtime: hold.runtime,
        priority: String(hold.priority),
        until: new Date(hold.until).toISOString(),
      });
    }
  }

  holdUntil(runtimeIds: string[], priority: number): number | undefined {
    const now = this.now();
    let blockedUntil: number | undefined;
    for (const [swapGroup, hold] of this.providerSwitchHolds) {
      if (hold.until <= now) {
        this.providerSwitchHolds.delete(swapGroup);
        continue;
      }
      const requested = runtimeIds.filter((runtimeId) =>
        getRuntime(this.registry, runtimeId)?.policy.swapGroup === swapGroup
      );
      if (requested.length === 0 || requested.includes(hold.runtime) || priority >= hold.priority) continue;
      blockedUntil = Math.max(blockedUntil ?? 0, hold.until);
    }
    return blockedUntil;
  }

  preemptLowerPriorityConflicts(input: {
    priority: number;
    runtimeIds: string[];
    allocations: readonly Allocation[];
    exclusiveResourceKeys: (runtimeIds: string[]) => Set<string>;
    preempt: (allocationId: string, priority: number) => unknown;
  }): void {
    if (input.priority < this.foregroundPriorityThreshold()) return;
    const requested = input.exclusiveResourceKeys(input.runtimeIds);
    const victims = input.allocations.filter((allocation) => {
      if (!admittedAllocation(allocation.status) || (allocation.priority ?? 0) >= input.priority) return false;
      const allocated = input.exclusiveResourceKeys(
        allocation.bindings.map((binding) => binding.runtime),
      );
      return [...requested].some((key) => allocated.has(key));
    });
    for (const allocation of victims) {
      void input.preempt(allocation.id, input.priority);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
