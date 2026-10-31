import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Anonymous cgroup memory is already charged to MemAvailable; reclaimable file cache is not. */
export async function systemServiceAnonymousMemoryBytes(unit: string, cgroupRoot = "/sys/fs/cgroup"): Promise<number | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(unit)) return undefined;
  try {
    const stat = await readFile(join(cgroupRoot, "system.slice", unit, "memory.stat"), "utf8");
    const value = /^anon ([0-9]+)$/m.exec(stat)?.[1];
    const bytes = value === undefined ? NaN : Number(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch { return undefined; }
}
