import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LinuxNodeTelemetry, parseMeminfo } from "./linux-node-telemetry";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("parses Linux memory and AMD VRAM telemetry", async () => {
  root = await mkdtemp(join(tmpdir(), "larm-telemetry-"));
  await mkdir(join(root, "proc"), { recursive: true });
  await mkdir(join(root, "sys/class/drm/card0/device"), { recursive: true });
  await writeFile(join(root, "proc/meminfo"), "MemTotal:       1048576 kB\nMemAvailable:    524288 kB\n");
  await writeFile(join(root, "sys/class/drm/card0/device/mem_info_vram_total"), "1073741824\n");
  await writeFile(join(root, "sys/class/drm/card0/device/mem_info_vram_used"), "268435456\n");
  await writeFile(join(root, "sys/class/drm/card0/device/mem_info_gtt_total"), "2147483648\n");
  await writeFile(join(root, "sys/class/drm/card0/device/mem_info_gtt_used"), "1073741824\n");
  const telemetry = await new LinuxNodeTelemetry({
    procRoot: join(root, "proc"),
    sysRoot: join(root, "sys"),
    now: () => 0,
  }).observe();
  expect(telemetry).toMatchObject({
    status: "available",
    observedAt: "1970-01-01T00:00:00.000Z",
    systemMemoryTotalBytes: 1024 ** 3,
    systemMemoryAvailableBytes: 512 * 1024 ** 2,
    acceleratorMemoryTotalBytes: 3 * 1024 ** 3,
    acceleratorMemoryAvailableBytes: 1792 * 1024 ** 2,
  });
});

test("telemetry failure is represented without throwing", async () => {
  root = await mkdtemp(join(tmpdir(), "larm-telemetry-"));
  const telemetry = await new LinuxNodeTelemetry({ procRoot: root, sysRoot: root }).observe();
  expect(telemetry.status).toBe("unavailable");
  expect(telemetry.detail).toContain("meminfo");
});

test("meminfo parser requires available memory", () => {
  expect(() => parseMeminfo("MemTotal: 12 kB\n")).toThrow(/MemAvailable/);
});
