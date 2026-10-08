import { expect, test } from "bun:test";
import { LocalServiceManager } from "./local-service-manager";
import { parseLocalServices, type LocalServiceBackend, type LocalServiceActivity } from "./local-service";
import { ServiceResourceLedger } from "./service-resource-ledger";

import { nativeFile } from "./testing/local-service-fixture";
test("v2 rejects unprepared manifests, wrong roots, unit and port alias conflicts, and v1 native definitions", () => {
  expect(parseLocalServices(nativeFile(), ["local-node"])[0]!.backend).toBe("systemd-process");
  const zero = nativeFile(); zero.services.fixture.deployment.manifestDigest = "0".repeat(64);
  expect(() => parseLocalServices(zero, ["local-node"])).toThrow("prepared manifest");
  const root = nativeFile(); root.services.fixture.storage.dataRoot = "/mnt/other";
  expect(() => parseLocalServices(root, ["local-node"])).toThrow("inside required mount");
  const units = nativeFile(); units.services.fixture.deployment.members.push(units.services.fixture.deployment.stopUnit);
  expect(() => parseLocalServices(units, ["local-node"])).toThrow("duplicate");
  const ports = nativeFile(); Object.assign(ports.services, { second: { ...structuredClone(ports.services.fixture), deployment: { ...ports.services.fixture.deployment, unit: "larm-local-service-other.service", stopUnit: "larm-local-service-other-stop.service", observeUnit: "larm-local-service-other-observe.service", members: ["larm-local-service-other-member.service"], endpoint: "http://127.0.0.1:19876/other" } } });
  expect(() => parseLocalServices(ports, ["local-node"])).toThrow("duplicate");
  expect(() => parseLocalServices({ ...nativeFile(), schemaVersion: "larm.local-services.v1" }, ["local-node"])).toThrow();
});

async function fixture(journalValue?: unknown) {
  const definitions = parseLocalServices(nativeFile(), ["local-node"]);
  let token: string | null = null, stopConfirmed = true, now = Date.now(), drain: string | null = null, saved = journalValue;
  const ledger = new ServiceResourceLedger();
  const activity = (): LocalServiceActivity => ({ contractVersion: "larm.local-service-activity.v1", bootId: "app", sequence: 1, observedAt: new Date(now).toISOString(), queuedJobs: 0, runningJobs: 0, activeRequests: 0, processorActiveJobs: 0, draining: !!drain, drainToken: drain });
  const backend: LocalServiceBackend = {
    start: async () => { token = "a".repeat(64); stopConfirmed = false; },
    stop: async (_, expected) => { expect(expected).toEqual({ instanceToken: "a".repeat(64), appBootId: "app", drainToken: "mine" }); token = null; stopConfirmed = true; },
    observe: async d => ({ serviceId: d.id, release: d.deployment.release, manifestDigest: d.deployment.manifestDigest, observedAt: new Date(now).toISOString(), state: token ? "running" : "stopped", instanceToken: token, stopConfirmed, memoryUsageBytes: 50 }),
    ready: async () => true, activity: async () => activity(), drain: async () => { drain = "mine"; return activity(); }, resume: async () => { drain = null; },
  };
  const options = { ledger, bootEpoch: "daemon", now: () => now, journal: { load: async () => saved, save: async (v: unknown) => { saved = v; } }, reserve: () => ledger.restore("fixture", "local-node", 1000) };
  const manager = new LocalServiceManager(definitions, backend, options);
  await manager.initialize();
  return { manager, ledger, backend, definitions, options, saved: () => saved, unconfirmed: () => { stopConfirmed = false; }, replace: () => { token = "b".repeat(64); }, advance: () => { now += 1000; } };
}
test("single-member native lifecycle uses guarded expectation and v2 journal, without container identities", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.manager.ensure("fixture", "a", "1", {}), f.manager.ensure("fixture", "b", "1", {})]); await f.manager.flush();
  expect(f.manager.get(a.id, "a").status).toBe("ready");
  f.manager.release(a.id, "a"); await expect(f.manager.stop("fixture")).rejects.toThrow("service_busy");
  f.manager.release(b.id, "b"); await f.manager.stop("fixture");
  expect(f.ledger.reservations()).toHaveLength(0);
  expect(f.saved()).toMatchObject({ version: 2, entries: [{ instanceToken: null }] });
  expect(JSON.stringify(f.saved())).not.toContain("containerIds");
});
test("native incomplete stop evidence retains reservation and replacement is never stopped", async () => {
  const f = await fixture(); const a = await f.manager.ensure("fixture", "a", "1", {}); await f.manager.flush(); f.manager.release(a.id, "a");
  f.backend.stop = async () => { f.unconfirmed(); };
  await expect(f.manager.stop("fixture")).rejects.toThrow("stop_unconfirmed");
  expect(f.ledger.reservations()).toHaveLength(1);
  const other = await fixture(); const b = await other.manager.ensure("fixture", "a", "1", {}); await other.manager.flush(); other.manager.release(b.id, "a"); other.replace();
  await expect(other.manager.stop("fixture")).rejects.toThrow("instance_changed");
  expect(other.ledger.reservations()).toHaveLength(1);
});
test("corrupt or unsupported journal is preserved and disables new activation", async () => {
  const corrupt = { version: 99, entries: [] };
  const f = await fixture(corrupt);
  await expect(f.manager.ensure("fixture", "a", "1", {})).rejects.toThrow("journal_recovery_required");
  await expect(f.manager.close()).rejects.toThrow("journal_recovery_required");
  expect(f.saved()).toEqual(corrupt);
});
