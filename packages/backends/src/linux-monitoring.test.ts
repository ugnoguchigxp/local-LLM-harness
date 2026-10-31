import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LinuxMonitoringSampler, parseKernelMonitoringFact } from "./linux-monitoring";
import { KernelMonitoringReader } from "./kernel-monitoring";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "larm-monitoring-")), proc = join(root, "proc"), sys = join(root, "sys");
  for (const path of ["pressure", "sys/kernel/random"]) await mkdir(join(proc, path), { recursive: true });
  await mkdir(join(sys, "class/drm"), { recursive: true });
  const write = (file: string, raw: string) => writeFile(join(proc, file), raw);
  await write("sys/kernel/random/boot_id", "11111111-1111-1111-1111-111111111111\n");
  await write("stat", "cpu  100 0 0 900 0 0 0 0 10 0\ncpu0 100 0 0 900 0 0 0 0\n");
  await write("loadavg", "0.10 0.20 0.30 1/100 123\n");
  await write("meminfo", "MemTotal: 100000 kB\nMemAvailable: 50000 kB\nSwapTotal: 1000 kB\nSwapFree: 750 kB\n");
  await write("vmstat", "pswpin 0\npswpout 12345678901234567890\noom_kill 3\n");
  for (const kind of ["cpu", "memory"]) await write(`pressure/${kind}`, "some avg10=0.00 avg60=0.01 avg300=0.02 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  return { root, proc, sys, write };
}
test("Linux values preserve units, zero, unsupported CPU full, cumulative precision and producer CPU intervals", async () => {
  const f = await fixture(); let mono = 0, clock = Date.parse("2026-10-18T08:30:00.000Z");
  const sampler = new LinuxMonitoringSampler({ nodeId: "node", procRoot: f.proc, sysRoot: f.sys, monotonic: () => mono, now: () => clock });
  try {
    const first = await sampler.observe();
    expect(first.node.cpu.utilization.status).toBe("unavailable"); expect(first.node.cpu.utilization.value).toBeUndefined();
    expect(first.node.memory.swapIn.value).toBe("0"); expect(first.node.memory.swapOut.value).toBe("12345678901234567890");
    expect(first.node.memory.memTotal.value).toBe(102400000); expect(first.node.memory.swapUsed.value).toBe(256000);
    expect(first.node.cpu.psi.full.total.status).toBe("unsupported"); expect(first.node.gpus.value).toEqual([]);
    clock += 2000; mono += 2000; await f.write("stat", "cpu  150 0 0 950 0 0 0 0 999 0\ncpu0 150 0 0 950 0 0 0 0\n");
    const a = sampler.observe(), b = sampler.observe(); expect(a).toBe(b);
    const second = await a; expect(second.node.cpu.utilization.value).toBe(50); expect(second.node.cpu.utilization.interval?.durationMs).toBe(2000);
    await f.write("meminfo", "broken"); clock += 2000; mono += 2000;
    const partial = await sampler.observe(); expect(partial.node.memory.memTotal.status).toBe("stale"); expect(partial.node.memory.memTotal.observedAt).toBe(second.node.memory.memTotal.observedAt);
    expect(partial.node.cpu.load1.status).toBe("ok"); expect(partial.node.memory.oomKills.status).toBe("ok");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("per-file permission failure does not fail host and permanently pending read is not duplicated", async () => {
  const f = await fixture(); let calls = 0;
  const read = async (path: string) => {
    if (path.endsWith("/loadavg")) { calls++; return await new Promise<string>(() => {}); }
    if (path.endsWith("/pressure/memory")) throw Object.assign(new Error("SECRET"), { code: "EACCES" });
    return await Bun.file(path).text();
  };
  try {
    const sampler = new LinuxMonitoringSampler({ nodeId: "node", procRoot: f.proc, sysRoot: f.sys, timeoutMs: 5, readText: read });
    const first = await sampler.observe(), second = await sampler.observe();
    expect(calls).toBe(1); expect(first.node.cpu.load1.status).toBe("error"); expect(second.node.memory.memTotal.status).toBe("ok");
    expect(first.node.memory.psi.some.total.status).toBe("permission_denied"); expect(JSON.stringify(first)).not.toContain("SECRET");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("kernel parser emits only explicit facts and reader distinguishes no facts, gaps, permissions and duplicate source records", async () => {
  const record = { _TRANSPORT: "kernel", MESSAGE: "amdgpu 0000:c5:00.0 ring gfx timeout SECRET", __CURSOR: "cursor-1", __REALTIME_TIMESTAMP: "1792312200000000" };
  const fact = parseKernelMonitoringFact(record)!; expect(fact.kind).toBe("gpu.ring_timeout_observed"); expect(fact.busId).toBe("0000:c5:00.0"); expect(JSON.stringify(fact)).not.toContain("SECRET");
  expect(parseKernelMonitoringFact({ ...record, MESSAGE: "HTTP 500 timeout" })).toBeUndefined();
  const reader = new KernelMonitoringReader({ run: async () => ({ stdout: JSON.stringify(record), stderr: "" }) });
  expect((await reader.read()).facts).toHaveLength(1); expect((await reader.read()).facts).toHaveLength(0);
  const denied = new KernelMonitoringReader({ run: async () => ({ stdout: "", stderr: "You are currently not seeing messages from other users" }) });
  expect((await denied.read()).coverage.status).toBe("permission_denied");
  const empty = new KernelMonitoringReader({ run: async () => ({ stdout: "", stderr: "" }) }); expect((await empty.read()).coverage.status).toBe("available");
  const gap = new KernelMonitoringReader({ run: async () => ({ stdout: Array(5001).fill(JSON.stringify(record)).join("\n"), stderr: "" }) }); expect((await gap.read()).coverage.reasonCode).toBe("journal_limit_exceeded");
});

test("multiple GPUs retain independent identity and memory pools when one GPU cannot be read", async () => {
  const f = await fixture();
  try {
    for (const n of [0, 1]) {
      const d = join(f.sys, `class/drm/card${n}/device`); await mkdir(d, { recursive: true });
      for (const [name, value] of Object.entries({ uevent: `PCI_SLOT_NAME=0000:0${n + 1}:00.0\n`, vendor: "0x1002", device: "0x1234", gpu_busy_percent: "0", mem_info_vram_total: "200", mem_info_vram_used: "100", mem_info_gtt_total: "1000", mem_info_gtt_used: "500" })) await writeFile(join(d, name), value);
    }
    const sampler = new LinuxMonitoringSampler({ nodeId: "node", procRoot: f.proc, sysRoot: f.sys,
      readText: async path => { if (path.endsWith("card0/device/uevent")) throw Object.assign(new Error("SECRET"), { code: "EACCES" }); return await Bun.file(path).text(); } });
    const result = await sampler.observe(); expect(result.node.gpus.status).toBe("ok"); expect(result.node.gpus.value).toHaveLength(2);
    const failed = result.node.gpus.value!.find(g => g.id === "drm-card0")!, good = result.node.gpus.value!.find(g => g.id === "gpu-0000:02:00.0")!;
    expect(failed.identity.status).toBe("permission_denied"); expect(good.utilization.value).toBe(0);
    expect(good.vramLimit.value).toBe(200); expect(good.gttLimit.value).toBe(1000); expect(good.attributedActiveRequests.status).toBe("unsupported");
    expect(result.node.memory.memAvailable.value).toBe(51200000);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
