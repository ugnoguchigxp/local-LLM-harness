import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeTelemetry } from "@larm/core";

export interface NodeTelemetryProvider {
  observe(): Promise<NodeTelemetry>;
}

export type LinuxNodeTelemetryOptions = {
  utilization?: boolean;
  procRoot?: string;
  sysRoot?: string;
  now?: () => number;
};

function parseMeminfo(value: string): { total: number; available: number } {
  const values = new Map<string, number>();
  for (const line of value.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) {
      values.set(match[1]!, Number(match[2]) * 1024);
    }
  }
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(available)) {
    throw new Error("MemTotal or MemAvailable is missing from /proc/meminfo");
  }
  return { total: total!, available: Math.min(total!, available!) };
}

async function readInteger(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENODEV" || code === "EACCES") {
      return undefined;
    }
    throw error;
  }
}

export class LinuxNodeTelemetry implements NodeTelemetryProvider {
  private previousCpu?: { total: number; idle: number };
  constructor(private readonly options: LinuxNodeTelemetryOptions = {}) {}

  async observe(): Promise<NodeTelemetry> {
    const observedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    try {
      const memory = parseMeminfo(await readFile(
        join(this.options.procRoot ?? "/proc", "meminfo"),
        "utf8",
      ));
      const accelerator = await this.acceleratorMemory();
      const systemCpuUtilization = this.options.utilization ? await this.cpuUtilization() : undefined;
      return {
        status: "available",
        observedAt,
        source: "linux-procfs-sysfs",
        ...(systemCpuUtilization === undefined ? {} : { systemCpuUtilization }),
        ...(accelerator?.busy === undefined ? {} : { acceleratorBusyMaxPercent: accelerator.busy }),
        systemMemoryTotalBytes: memory.total,
        systemMemoryAvailableBytes: memory.available,
        ...(accelerator === undefined
          ? {}
          : {
            acceleratorMemoryTotalBytes: accelerator.total,
            acceleratorMemoryAvailableBytes: accelerator.available,
          }),
      };
    } catch (error) {
      return {
        status: "unavailable",
        observedAt,
        source: "linux-procfs-sysfs",
        detail: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      };
    }
  }

  private async cpuUtilization(): Promise<number | undefined> {
    try {
      const line = (await readFile(join(this.options.procRoot ?? "/proc", "stat"), "utf8")).split("\n")[0]!;
      const values = line.trim().split(/\s+/).slice(1, 9).map(Number);
      if (!line.startsWith("cpu ") || values.length < 4 || values.some(value => !Number.isFinite(value) || value < 0)) return undefined;
      const current = { total: values.reduce((sum, value) => sum + value, 0), idle: values[3]! + (values[4] ?? 0) };
      const previous = this.previousCpu;
      this.previousCpu = current;
      if (!previous || current.total <= previous.total || current.idle < previous.idle) return undefined;
      return Math.max(0, Math.min(1, 1 - (current.idle - previous.idle) / (current.total - previous.total)));
    } catch { return undefined; }
  }

  private async acceleratorMemory(): Promise<{ total: number; available: number; busy?: number } | undefined> {
    const drmRoot = join(this.options.sysRoot ?? "/sys", "class/drm");
    let entries: string[];
    try {
      entries = await readdir(drmRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") {
        return undefined;
      }
      throw error;
    }
    let busy: number | undefined;
    let total = 0;
    let used = 0;
    let observed = false;
    for (const entry of entries.filter((value) => /^card\d+$/.test(value))) {
      const device = join(drmRoot, entry, "device");
      const cardBusy = this.options.utilization ? await readInteger(join(device, "gpu_busy_percent")).catch(() => undefined) : undefined;
      if (cardBusy !== undefined && cardBusy <= 100) busy = Math.max(busy ?? 0, cardBusy);
      const cardTotal = await readInteger(join(device, "mem_info_vram_total"));
      const cardUsed = await readInteger(join(device, "mem_info_vram_used"));
      if (cardTotal === undefined || cardUsed === undefined) {
        continue;
      }
      observed = true;
      const gttTotal = await readInteger(join(device, "mem_info_gtt_total")) ?? 0;
      const gttUsed = await readInteger(join(device, "mem_info_gtt_used")) ?? 0;
      total += cardTotal + gttTotal;
      used += Math.min(cardTotal, cardUsed) + Math.min(gttTotal, gttUsed);
    }
    return observed ? { total, available: Math.max(0, total - used), ...(busy === undefined ? {} : { busy }) } : undefined;
  }
}

export { parseMeminfo };
