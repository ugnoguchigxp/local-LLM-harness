import { getRuntime, type Registry } from "./registry";

/** A swap group excludes different runtimes, not separate leases of one runtime. */
export function runtimeSetsConflict(
  registry: Registry,
  requestedRuntimeIds: readonly string[],
  existingRuntimeIds: readonly string[],
  exclusive: boolean,
): boolean {
  return requestedRuntimeIds.some((requestedId) => existingRuntimeIds.some((existingId) => {
    const requested = getRuntime(registry, requestedId);
    if (requestedId === existingId) {
      return !exclusive || requested?.resources.maxConcurrentAllocations === 1;
    }
    const existing = getRuntime(registry, existingId);
    return requested?.policy.swapGroup !== undefined
      && requested.policy.swapGroup === existing?.policy.swapGroup;
  }));
}
