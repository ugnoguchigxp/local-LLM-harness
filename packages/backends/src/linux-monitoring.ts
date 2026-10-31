import { readFile, readdir, realpath, stat, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  monitoringSample as sample, monitoringValues, monitoringGpusSchema, monitoringStoragesSchema,
  type MonitoringObservation, type MonitoringSnapshot, type MonitoringGpu, type MonitoringEvent,
} from "@larm/core";

type NodeView = MonitoringSnapshot["nodes"][number];
type Fault = { status: "error" | "unsupported" | "permission_denied" | "unavailable"; reason: string };
function fault(error: unknown): Fault {
  const code = (error as { code?: string }).code;
  if (code === "EACCES" || code === "EPERM") return { status: "permission_denied", reason: "sensor_access_denied" };
  if (code === "ENOENT" || code === "ENODEV") return { status: "unsupported", reason: "sensor_not_supported" };
  if (code === "EBASELINE") return { status: "unavailable", reason: "baseline_required" };
  if (code === "EHOSTEPOCH") return { status: "unavailable", reason: "host_epoch_unavailable" };
  if (code === "ECLOCK") return { status: "unavailable", reason: "clock_discontinuity" };
  if (code === "EINVAL") return { status: "error", reason: "invalid_sensor_value" };
  return { status: "error", reason: code === "ETIMEDOUT" ? "sensor_timeout" : "sensor_read_failed" };
}
function invalid(): never { throw Object.assign(new Error("invalid_sensor_value"), { code: "EINVAL" }); }
function integer(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) return invalid();
  const n = Number(raw.trim()); if (!Number.isSafeInteger(n) || n < 0) return invalid(); return n;
}
function finite(raw: string): number { const n = Number(raw); if (!Number.isFinite(n) || n < 0) return invalid(); return n; }
export function parseMonitoringMeminfo(raw: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) { const m = /^(\w+):\s+(\d+) kB$/.exec(line); if (m) values.set(m[1]!, integer(m[2]!) * 1024); }
  return values;
}
export function parseMonitoringCpu(raw: string): { total: number; idle: number; cores: number; iowait: number } {
  const line = raw.split("\n")[0]!;
  if (!/^cpu\s/.test(line)) return invalid();
  const fields = line.trim().split(/\s+/).slice(1, 9).map(integer);
  if (fields.length < 8) return invalid();
  const cores = raw.split("\n").filter(s => /^cpu\d+\s/.test(s)).length; if (!cores) invalid();
  return { total: fields.reduce((a, b) => a + b, 0), idle: fields[3]! + fields[4]!, iowait: fields[4]!, cores };
}

export class LinuxMonitoringSampler {
  private readonly previous = new Map<string, MonitoringObservation<unknown>>();
  private readonly reads = new Map<string, Promise<string>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private flight?: Promise<{ node: NodeView; modelStorage: MonitoringSnapshot["modelStorage"] }>;
  private cpu?: { total: number; idle: number; cores: number; iowait: number; at: string; mono: number };
  private hostBootId?: string;
  private storage?: MonitoringSnapshot["modelStorage"];
  private storageAt = -Infinity;
  constructor(private readonly options: {
    nodeId: string; procRoot?: string; sysRoot?: string; now?: () => number; monotonic?: () => number;
    timeoutMs?: number; artifacts?: { id: string; path: string; kind: string }[];
    readText?: (path: string) => Promise<string>;
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private mono(): number { return this.options.monotonic?.() ?? performance.now(); }
  private at(): string { return new Date(this.now()).toISOString(); }
  private proc(name: string): string { return join(this.options.procRoot ?? "/proc", name); }
  private async io<T>(key: string, work: () => Promise<T>): Promise<T> {
    let operation = this.operations.get(key) as Promise<T> | undefined;
    if (!operation) {
      operation = work(); this.operations.set(key, operation);
      void operation.finally(() => { if (this.operations.get(key) === operation) this.operations.delete(key); }).catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("sensor_timeout"), { code: "ETIMEDOUT" })), this.options.timeoutMs ?? 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async read(path: string): Promise<string> {
    let p = this.reads.get(path);
    if (!p) {
      p = (this.options.readText ? this.options.readText(path) : readFile(path, "utf8"));
      this.reads.set(path, p);
      void p.finally(() => { if (this.reads.get(path) === p) this.reads.delete(path); }).catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("sensor_timeout"), { code: "ETIMEDOUT" })), this.options.timeoutMs ?? 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async metric<T>(key: string, type: keyof typeof monitoringValues | "devices" | "filesystems" | "identity", source: string, work: () => Promise<T>, options: { counterEpoch?: string; maxAgeMs?: number; interval?: () => MonitoringObservation<T>["interval"] } = {}): Promise<MonitoringObservation<T>> {
    try {
      if (["counter", "pages", "psiTotal"].includes(type) && !options.counterEpoch) throw Object.assign(new Error("host_epoch_unavailable"), { code: "EHOSTEPOCH" });
      const value = await work();
      const result = sample(type, source, this.at(), value, { ...options, interval: options.interval?.() ?? undefined });
      const schema = type === "devices" ? monitoringGpusSchema : type === "filesystems" ? monitoringStoragesSchema : type === "identity" ? undefined : monitoringValues[type];
      if (schema && !schema.safeParse(result).success) invalid();
      this.previous.set(key, result); return result;
    } catch (error) {
      const f = fault(error); const old = this.previous.get(key);
      if (old) return { ...structuredClone(old), status: "stale", lastAttempt: { at: this.at(), status: f.status, reasonCode: f.reason } } as MonitoringObservation<T>;
      return sample<T>(type, source, this.at(), undefined, { ...options, status: f.status, reason: f.reason, interval: undefined });
    }
  }
  observe(): Promise<{ node: NodeView; modelStorage: MonitoringSnapshot["modelStorage"] }> {
    if (this.flight) return this.flight;
    this.flight = this.collect().finally(() => { this.flight = undefined; }); return this.flight;
  }
  private async psi(resource: "cpu" | "memory"): Promise<NodeView["cpu"]["psi"]> {
    const source = `proc-psi-${resource}`;
    const scope = async (scope: "some" | "full") => {
      const get = async (field: string): Promise<string> => {
        const line = (await this.read(this.proc(`pressure/${resource}`))).split("\n").find(l => l.startsWith(`${scope} `));
        const m = line?.match(new RegExp(`(?:^| )${field}=([0-9.]+)(?: |$)`)); if (!m) return invalid(); return m[1]!;
      };
      if (resource === "cpu" && scope === "full") return Object.fromEntries(["avg10", "avg60", "avg300", "total"].map(k => [k, sample(k === "total" ? "psiTotal" : "percent", source, this.at(), undefined, { status: "unsupported", reason: "cpu_full_not_defined" })])) as NodeView["cpu"]["psi"]["some"];
      const [avg10, avg60, avg300, total] = await Promise.all([
        ...["avg10", "avg60", "avg300"].map(k => this.metric(`${resource}.${scope}.${k}`, "percent", source, async () => finite(await get(k)))),
        this.metric(`${resource}.${scope}.total`, "psiTotal", source, async () => { const v = await get("total"); if (!/^\d+$/.test(v)) invalid(); return BigInt(v).toString(); }, { counterEpoch: this.hostBootId }),
      ]);
      return { avg10, avg60, avg300, total } as NodeView["cpu"]["psi"]["some"];
    };
    const [some, full] = await Promise.all([scope("some"), scope("full")]); return { some, full };
  }
  private async collect(): Promise<{ node: NodeView; modelStorage: MonitoringSnapshot["modelStorage"] }> {
    if (!this.hostBootId) {
      try { const id = (await this.read(this.proc("sys/kernel/random/boot_id"))).trim(); if (!/^[a-f0-9-]{36}$/.test(id)) invalid(); this.hostBootId = `host-${id}`; }
      catch { /* Host gauges remain useful without a trustworthy cumulative epoch. */ }
    }
    const getMem = async (key: string): Promise<number> => { const values = parseMonitoringMeminfo(await this.read(this.proc("meminfo"))); const n = values.get(key); if (n === undefined || !Number.isSafeInteger(n)) invalid(); return n!; };
    const vm = async (name: string): Promise<string> => {
      const line = (await this.read(this.proc("vmstat"))).split("\n").find(l => l.startsWith(`${name} `));
      const m = line?.match(/^[a-z_]+ (\d+)$/); if (!m) invalid(); return BigInt(m![1]!).toString();
    };
    let cpuInterval: MonitoringObservation<number>["interval"];
    const cpuReading = this.read(this.proc("stat")).then(parseMonitoringCpu);
    const utilization = this.metric("cpu.utilization", "cpuPercent", "proc-stat", async () => {
      const c = await cpuReading, at = this.at(), mono = this.mono(), prev = this.cpu;
      this.cpu = { ...c, at, mono };
      if (!prev) throw Object.assign(new Error("baseline_required"), { code: "EBASELINE" });
      if (Date.parse(at) <= Date.parse(prev.at) || mono <= prev.mono) throw Object.assign(new Error("clock_discontinuity"), { code: "ECLOCK" });
      if (c.cores !== prev.cores || c.total <= prev.total || c.idle < prev.idle || c.iowait < prev.iowait) throw Object.assign(new Error("baseline_required"), { code: "EBASELINE" });
      const value = 100 * (1 - (c.idle - prev.idle) / (c.total - prev.total));
      cpuInterval = { startAt: prev.at, endAt: at, durationMs: mono - prev.mono }; return value;
    }, { interval: () => cpuInterval });
    const [logicalCores, cpuUtil, loads, cpuPsi, memTotal, memAvailable, swapTotal, swapUsed, swapIn, swapOut, pageSize, memoryPsi, oomKills, gpus, modelStorage] = await Promise.all([
      this.metric("cpu.cores", "count", "proc-stat", async () => (await cpuReading).cores), utilization,
      Promise.all([0, 1, 2].map(index => this.metric(`cpu.load${index}`, "load", "proc-loadavg", async () => finite((await this.read(this.proc("loadavg"))).trim().split(/\s+/)[index]!)))),
      this.psi("cpu"),
      this.metric("mem.total", "bytes", "proc-meminfo", () => getMem("MemTotal")),
      this.metric("mem.available", "bytes", "proc-meminfo", async () => { const [available, total] = await Promise.all([getMem("MemAvailable"), getMem("MemTotal")]); if (available > total) invalid(); return available; }),
      this.metric("swap.total", "bytes", "proc-meminfo", () => getMem("SwapTotal")),
      this.metric("swap.used", "bytes", "proc-meminfo", async () => { const [total, free] = await Promise.all([getMem("SwapTotal"), getMem("SwapFree")]); if (free > total) invalid(); return total - free; }),
      this.metric("swap.in", "pages", "proc-vmstat", () => vm("pswpin"), { counterEpoch: this.hostBootId }),
      this.metric("swap.out", "pages", "proc-vmstat", () => vm("pswpout"), { counterEpoch: this.hostBootId }),
      this.metric("pageSize", "bytes", "sysconf", async () => new Promise<number>((resolve, reject) => execFile("getconf", ["PAGESIZE"], { timeout: 1000, maxBuffer: 64 }, (e, stdout) => e ? reject(e) : resolve(integer(stdout))))),
      this.psi("memory"), this.metric("oom", "counter", "proc-vmstat", () => vm("oom_kill"), { counterEpoch: this.hostBootId }),
      this.metric("gpu.inventory", "devices", "drm-sysfs", () => this.gpus()), this.storages(),
    ]);
    return { node: { nodeId: this.options.nodeId, hostBootId: this.hostBootId ?? "host-unavailable", scope: "local_host",
      cpu: { logicalCores, utilization: cpuUtil, load1: loads[0]!, load5: loads[1]!, load15: loads[2]!, psi: cpuPsi },
      memory: { memTotal, memAvailable, swapTotal, swapUsed, swapIn, swapOut, pageSize, psi: memoryPsi, oomKills, aggregationPolicy: "do_not_add_host_vram_gtt" }, gpus }, modelStorage };
  }
  private async gpus(): Promise<MonitoringGpu[]> {
    const root = join(this.options.sysRoot ?? "/sys", "class/drm");
    const cards = (await this.io(`readdir:${root}`, () => readdir(root))).filter(s => /^card\d+$/.test(s));
    const seen = new Set<string>(), result: MonitoringGpu[] = [];
    for (const card of cards) {
      const device = join(root, card, "device");
      try {
      const path = await this.io(`realpath:${device}`, () => realpath(device)); if (seen.has(path)) continue; seen.add(path);
      const uevent = await this.read(join(device, "uevent"));
      const bus = uevent.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1] ?? basename(path);
      const id = `gpu-${bus.replace(/[^a-zA-Z0-9._:-]/g, "-")}`;
      const driver = await this.io(`driver:${device}`, () => realpath(join(device, "driver"))).then(basename, () => "unknown");
      const identity = await this.metric(`${id}.identity`, "identity", "drm-sysfs", async () => ({ busId: bus, vendorId: (await this.read(join(device, "vendor"))).trim(), deviceId: (await this.read(join(device, "device"))).trim(), driver }));
      const readNumber = (key: string, file: string, type: "bytes" | "percent" = "bytes") => this.metric(`${id}.${key}`, type, "drm-sysfs", async () => integer(await this.read(join(device, file))));
      const [utilization, vramUsed, vramLimit, gttUsed, gttLimit] = await Promise.all([
        readNumber("busy", "gpu_busy_percent", "percent"), readNumber("vramUsed", "mem_info_vram_used"), readNumber("vramLimit", "mem_info_vram_total"), readNumber("gttUsed", "mem_info_gtt_used"), readNumber("gttLimit", "mem_info_gtt_total"),
      ]);
      const temperatures: MonitoringGpu["temperatures"] = [], clocks: MonitoringGpu["clocks"] = [];
      let hwm: string[];
      try { hwm = await this.io(`hwmon:${device}`, () => readdir(join(device, "hwmon"))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") hwm = []; else throw e; }
      for (const hw of hwm) for (const field of await this.io(`hwmon:${device}:${hw}`, () => readdir(join(device, "hwmon", hw)))) {
        const m = /^(temp|freq)(\d+)_input$/.exec(field); if (!m) continue;
        const metric = await this.metric(`${id}.${hw}.${field}`, m[1] === "temp" ? "temperature" : "frequency", "hwmon", async () => {
          const raw = (await this.read(join(device, "hwmon", hw, field))).trim(); const value = Number(raw); if (!Number.isFinite(value)) invalid(); return m[1] === "temp" ? value / 1000 : value;
        });
        (m[1] === "temp" ? temperatures : clocks).push({ id: `${hw}-${m[1]}${m[2]}`, value: metric });
      }
      const unsupported = <T>(type: keyof typeof monitoringValues) => sample<T>(type, "daemon-state", this.at(), undefined, { status: "unsupported", reason: "runtime_device_mapping_absent" });
      result.push({ id, nodeId: this.options.nodeId, identity, utilization, temperatures, clocks,
        thermalThrottled: sample("boolean", "amdgpu-metrics", this.at(), undefined, { status: "unsupported", reason: "driver_metric_not_decoded" }),
        vramUsed, vramLimit, gttUsed, gttLimit, memoryRelationship: "shared_or_unknown",
        attributedActiveRequests: unsupported("count"), attributedQueuedRequests: unsupported("count"), oldestAttributedQueueWaitMs: unsupported("milliseconds"),
        lastDecodeTokensPerSecond: unsupported("decodeRate"), lastFirstResponseMs: unsupported("milliseconds") });
      } catch (error) {
        const f = fault(error), absent = <T>(type: keyof typeof monitoringValues | "identity") => sample<T>(type, "drm-sysfs", this.at(), undefined, { status: f.status, reason: f.reason });
        result.push({ id: `drm-${card}`, nodeId: this.options.nodeId, identity: absent("identity"), utilization: absent("percent"), temperatures: [], clocks: [],
          thermalThrottled: absent("boolean"), vramUsed: absent("bytes"), vramLimit: absent("bytes"), gttUsed: absent("bytes"), gttLimit: absent("bytes"), memoryRelationship: "shared_or_unknown",
          attributedActiveRequests: absent("count"), attributedQueuedRequests: absent("count"), oldestAttributedQueueWaitMs: absent("milliseconds"), lastDecodeTokensPerSecond: absent("decodeRate"), lastFirstResponseMs: absent("milliseconds") });
      }
    }
    return result;
  }
  private async storages(): Promise<MonitoringSnapshot["modelStorage"]> {
    if (this.storage && this.mono() - this.storageAt < 60_000) return structuredClone(this.storage);
    this.storageAt = this.mono();
    this.storage = await this.metric("storages", "filesystems", "statfs", async () => {
      const groups = new Map<number, { path: string; artifactIds: string[] }>();
      for (const artifact of this.options.artifacts ?? []) {
        const path = artifact.kind === "file" ? dirname(artifact.path) : artifact.path;
        try { const st = await this.io(`stat:${path}`, () => stat(path)); const old = groups.get(st.dev); if (old) old.artifactIds.push(artifact.id); else groups.set(st.dev, { path, artifactIds: [artifact.id] }); }
        catch { // Keep an explicit failed entry for an unavailable configured filesystem.
          groups.set(-groups.size - 1, { path, artifactIds: [artifact.id] });
        }
      }
      return await Promise.all([...groups].map(async ([dev, group]) => {
        const id = `model-fs-${createHash("sha256").update(dev < 0 ? group.path : String(dev)).digest("hex").slice(0, 24)}`;
        const get = async (available: boolean) => { const fs = await this.io(`statfs:${group.path}`, () => statfs(group.path, { bigint: true })); const n = (available ? fs.bavail : fs.blocks) * fs.bsize; if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(n); };
        const [total, availableToDaemon] = await Promise.all([this.metric(`${id}.total`, "bytes", "statfs", () => get(false), { maxAgeMs: 120_000 }), this.metric(`${id}.available`, "bytes", "statfs", () => get(true), { maxAgeMs: 120_000 })]);
        return { id, nodeId: this.options.nodeId, artifactIds: group.artifactIds, total, availableToDaemon };
      }));
    }, { maxAgeMs: 120_000 });
    return structuredClone(this.storage);
  }
}

export type KernelMonitoringFact = Pick<MonitoringEvent, "kind" | "occurredAt" | "sourceEventId"> & { busId?: string; reasonCode: string };
/** Only explicit kernel facts are extracted. No raw MESSAGE or provider response leaves this parser. */
export function parseKernelMonitoringFact(record: Record<string, unknown>): KernelMonitoringFact | undefined {
  if (record._TRANSPORT !== "kernel" || typeof record.MESSAGE !== "string" || typeof record.__CURSOR !== "string" || typeof record.__REALTIME_TIMESTAMP !== "string") return;
  const msg = record.MESSAGE;
  let kind: MonitoringEvent["kind"] | undefined, reasonCode: string | undefined;
  if (/Out of memory: Killed process|oom-kill:/.test(msg)) { kind = "host.oom_kill_observed"; reasonCode = "kernel_oom_kill"; }
  else if (/amdgpu|drm/i.test(msg)) {
    if (/GPU reset (?:begin|succeeded|failed)/i.test(msg)) { kind = "gpu.reset_observed"; reasonCode = /failed/i.test(msg) ? "gpu_reset_failed" : "gpu_reset_observed"; }
    else if (/ring .*timeout|amdgpu_job_timedout/i.test(msg)) { kind = "gpu.ring_timeout_observed"; reasonCode = "gpu_ring_timeout"; }
    else if (/page fault|VM_L2_PROTECTION_FAULT/i.test(msg)) { kind = "gpu.page_fault_observed"; reasonCode = "gpu_page_fault"; }
  }
  if (!kind || !reasonCode || !/^\d+$/.test(record.__REALTIME_TIMESTAMP)) return;
  const ms = Number(BigInt(record.__REALTIME_TIMESTAMP) / 1000n); if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) return;
  return { kind, reasonCode, occurredAt: new Date(ms).toISOString(), sourceEventId: createHash("sha256").update(record.__CURSOR).digest("hex"),
    ...(msg.match(/\b[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]\b/i)?.[0] ? { busId: msg.match(/\b[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]\b/i)![0].toLowerCase() } : {}) };
}
