import type { Registry } from "./registry";
import type { PrepareRequest } from "./api-schema";

export type ExpandPrepareResult =
  | { ok: true; capabilities: string[]; profile?: string }
  | { ok: false; reason: "unknown_profile" | "empty" };

export function expandPrepareRequest(
  registry: Registry,
  request: PrepareRequest,
): ExpandPrepareResult {
  const capabilities = new Set<string>(request.capabilities ?? []);
  if (request.profile) {
    const profile = registry.profiles.find((item) => item.id === request.profile);
    if (!profile) {
      return { ok: false, reason: "unknown_profile" };
    }
    for (const capability of profile.require) {
      capabilities.add(capability);
    }
  }
  if (capabilities.size === 0) {
    return { ok: false, reason: "empty" };
  }
  return {
    ok: true,
    capabilities: [...capabilities].sort(),
    profile: request.profile,
  };
}
