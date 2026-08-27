export type Lease = {
  id: string;
  client?: string;
  capabilities: string[];
  profile?: string;
  createdAt: string;
};

export function createLeaseId(random?: () => string): string {
  const id = (random ?? (() => crypto.randomUUID()))();
  return `lease_${id}`;
}

export function desiredCapabilities(
  residentCapabilities: string[],
  leases: Lease[],
): string[] {
  const set = new Set<string>(residentCapabilities);
  for (const lease of leases) {
    for (const capability of lease.capabilities) {
      set.add(capability);
    }
  }
  return [...set].sort();
}

export function residentCapabilitiesFrom(
  runtimes: { policy: { class: string }; capability: string[] }[],
): string[] {
  const set = new Set<string>();
  for (const runtime of runtimes) {
    if (runtime.policy.class === "resident") {
      for (const capability of runtime.capability) {
        set.add(capability);
      }
    }
  }
  return [...set];
}
