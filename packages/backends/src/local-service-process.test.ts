import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLocalServices } from "@larm/core";
import { nativeFile } from "../../core/src/testing/local-service-fixture";
import { SystemdProcessBackend, processServiceObservationSchema } from "./local-service-process";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "larm-process-")); roots.push(root);
  const d = parseLocalServices(nativeFile(), ["local-node"])[0]!;
  const now = Date.now(), calls: string[][] = [];
  const o = { serviceId: d.id, release: d.deployment.release, manifestDigest: d.deployment.manifestDigest, observedAt: new Date(now).toISOString(), state: "stopped", instanceToken: null as string | null, stopConfirmed: true, memoryUsageBytes: 0, memory: { anon: 0, file: 0, shmem: 0, total: 0 } };
  const path = join(root, "fixture.json");
  await writeFile(path, JSON.stringify(o));
  const backend = new SystemdProcessBackend({ secretRoot: root, observationRoot: root, requestRoot: join(root, "requests"), now: () => now,
    control: async args => {
      calls.push(args);
      if (args[1].includes("-stop")) {
        const request = JSON.parse(await readFile(join(root, "requests/fixture.json"), "utf8"));
        expect(request).toMatchObject({ instanceToken: "a".repeat(64), appBootId: "app", drainToken: "mine", manifestDigest: d.deployment.manifestDigest });
      }
    },
    fetch: (async () => Response.json({ status: "ready" })) as unknown as typeof fetch,
  });
  return { root, d, o, path, calls, backend };
}
test("process observer rejects false stop, stale snapshots, and incomplete identity", async () => {
  const f = await fixture(); expect((await f.backend.observe(f.d)).stopConfirmed).toBe(true);
  expect(processServiceObservationSchema.safeParse({ ...f.o, state: "running" }).success).toBe(false);
  expect(processServiceObservationSchema.safeParse({ ...f.o, state: "stopped", stopConfirmed: false }).success).toBe(false);
  await writeFile(f.path, JSON.stringify({ ...f.o, observedAt: new Date(Date.now() - 10000).toISOString() }));
  await expect(f.backend.observe(f.d)).rejects.toThrow("observation_untrusted");
});
test("prepared single process start resets only confirmed empty entry and stop requests are scoped and ephemeral", async () => {
  const f = await fixture(); await f.backend.start(f.d);
  expect(f.calls).toEqual([["start", "larm-local-service-fixture-observe.service"], ["stop", "larm-local-service-fixture.service"], ["start", "larm-local-service-fixture.service"]]);
  await f.backend.stop(f.d, { instanceToken: "a".repeat(64), appBootId: "app", drainToken: "mine" });
  expect(await readdir(join(f.root, "requests"))).toEqual([]);
  await expect(f.backend.stop(f.d)).rejects.toThrow("stop_expectation_required");
  await writeFile(f.path, JSON.stringify({ ...f.o, state: "running", instanceToken: "a".repeat(64), stopConfirmed: false }));
  await expect(f.backend.start(f.d)).rejects.toThrow("start_requires_stopped_group");
});
test("generic readiness honors configured status and capabilities", async () => {
  const f = await fixture(); expect(await f.backend.ready(f.d)).toBe(true);
  if (f.d.backend !== "systemd-process") throw new Error();
  f.d.readiness.capabilities = { source_management: true };
  expect(await f.backend.ready(f.d)).toBe(false);
});
