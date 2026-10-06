import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseLocalServices } from "@larm/core";
import { LocalServiceSystemdBackend } from "./local-service-systemd";
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
test("stop invokes the guarded helper even when the supervising unit is inactive", async () => {
  const d = parseLocalServices(parse(readFileSync("config/local-node/local-services.yaml", "utf8")), ["local-node"])[0]!;
  let containersRunning = true, helperCalls = 0;
  const backend = new LocalServiceSystemdBackend({ observationRoot: "unused", secretRoot: "unused",
    control: async args => {
      if (args[0] === "start" && args[1] === d.deployment.stopUnit) {
        helperCalls++; containersRunning = false;
      }
      // systemctl stop on an already inactive supervisor does not execute ExecStop.
    },
  });
  await backend.stop(d);
  expect(containersRunning).toBe(false); expect(helperCalls).toBe(1);
});
test("strict App readiness and scoped lifecycle calls don't confuse status ready with alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-backend-")); roots.push(root);
  await writeFile(join(root, "docling-lifecycle-token"), "x".repeat(40));
  const d = parseLocalServices(parse(readFileSync("config/local-node/local-services.yaml", "utf8")), ["local-node"])[0]!;
  let ready = false;
  const now = Date.parse("2026-10-06T00:00:00Z"), commands: string[][] = [];
  const backend = new LocalServiceSystemdBackend({ observationRoot: root, secretRoot: root, now: () => now,
    control: async args => { commands.push(args); },
    fetch: (async (url, init) => {
      if (String(url).endsWith("/health/ready")) return Response.json({ status: "ready", capabilities: { source_management: ready } });
      expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${"x".repeat(40)}`);
      return Response.json({ contractVersion: "larm.local-service-activity.v1", bootId: "app", sequence: 1, observedAt: new Date(now).toISOString(), queuedJobs: 0, runningJobs: 0, activeRequests: 0, processorActiveJobs: 0, draining: false, drainToken: null });
    }) as typeof fetch,
  });
  expect(await backend.ready(d)).toBe(false); ready = true; expect(await backend.ready(d)).toBe(true);
  await writeFile(join(root, "docling-desk.json"), JSON.stringify({ serviceId: "docling-desk", release: d.deployment.release, manifestDigest: d.deployment.manifestDigest, state: "failed", containerIds: [], memoryUsageBytes: 0, observedAt: new Date(now).toISOString() }));
  expect((await backend.activity(d)).runningJobs).toBe(0); await backend.start(d); await backend.stop(d);
  expect(commands).toEqual([["stop", "larm-local-service-docling-desk.service"], ["start", "larm-local-service-docling-desk.service"], ["start", "larm-local-service-docling-desk-stop.service"], ["stop", "larm-local-service-docling-desk.service"]]);
  await writeFile(join(root, "docling-desk.json"), JSON.stringify({ serviceId: "docling-desk", release: d.deployment.release, manifestDigest: d.deployment.manifestDigest, state: "running", containerIds: ["a".repeat(64), "b".repeat(64)], memoryUsageBytes: 100, observedAt: new Date(now).toISOString() }));
  await expect(backend.start(d)).rejects.toThrow("start_requires_stopped_group");
  expect(commands).toHaveLength(4);
  await writeFile(join(root, "docling-desk.json"), JSON.stringify({ serviceId: "docling-desk", release: d.deployment.release, manifestDigest: d.deployment.manifestDigest, state: "stopped", containerIds: [], memoryUsageBytes: 0, observedAt: new Date(now - 20000).toISOString() }));
  await expect(backend.observe(d)).rejects.toThrow("observation_untrusted");
});
