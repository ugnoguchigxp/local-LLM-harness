import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseLocalServices, ServiceResourceLedger, type LocalServiceActivity } from "@larm/core";
import { LocalServiceFileJournal, type LocalServiceBackend } from "@larm/backends";
import { LocalServiceManager } from "./local-service-manager";
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function fixture() {
  let now = Date.parse("2026-10-06T00:00:00Z"), running = false, starts = 0, stops = 0, busy = 0, sequence = 1, drain: string | null = null;
  let unavailable = false, stopFails = false;
  const a = (): LocalServiceActivity => ({ contractVersion: "larm.local-service-activity.v1", bootId: "app-1", sequence: ++sequence,
    observedAt: new Date(now).toISOString(), queuedJobs: 0, runningJobs: busy, activeRequests: 0, processorActiveJobs: busy,
    draining: drain !== null, drainToken: drain });
  const backend: LocalServiceBackend = {
    start: async () => { running = true; starts++; },
    stop: async () => { if (stopFails) throw new Error("timeout"); running = false; stops++; },
    observe: async () => ({ serviceId: "docling-desk", release: "docling-knowledge-cpu-v1", manifestDigest: "0".repeat(64), observedAt: new Date(now).toISOString(), state: running ? "running" : "stopped", containerIds: running ? ["a".repeat(64), "b".repeat(64)] : [], memoryUsageBytes: 100 }),
    ready: async () => true,
    activity: async () => { if (unavailable) throw new Error("offline"); return a(); },
    drain: async () => { drain = "drain-1"; return a(); },
    resume: async () => { drain = null; },
  };
  const root = await mkdtemp(join(tmpdir(), "larm-service-")); roots.push(root);
  const definitions = parseLocalServices(parse(readFileSync("config/local-node/local-services.yaml", "utf8")), ["local-node"]);
  const ledger = new ServiceResourceLedger();
  const opts = { bootEpoch: "daemon-1", journal: new LocalServiceFileJournal(join(root, "state.json")), ledger, now: () => now,
    reserve: (id: string) => ledger.restore(id, "local-node", 9000), sleep: async () => { now += 250; } };
  const manager = new LocalServiceManager(definitions, backend, opts); await manager.initialize();
  return { manager, ledger, backend, definitions, opts, get starts() { return starts; }, get stops() { return stops; },
    busy: (n: number) => { busy = n; }, pulse: () => { sequence += 2; }, advance: (ms: number) => { now += ms; }, offline: () => { unavailable = true; }, stopFails: () => { stopFails = true; } };
}
test("two callers coalesce startup; scoped idempotency and ownership", async () => {
  const f = await fixture();
  const [l1, l2] = await Promise.all([f.manager.ensure("docling-desk", "alice", "one", {}), f.manager.ensure("docling-desk", "bob", "one", {})]);
  await f.manager.flush(); expect(f.starts).toBe(1); expect(f.manager.get(l1.id, "alice").status).toBe("ready");
  expect((await f.manager.ensure("docling-desk", "alice", "one", {})).id).toBe(l1.id);
  await expect(f.manager.ensure("docling-desk", "alice", "one", { ttlSeconds: 20 })).rejects.toThrow("idempotency_conflict");
  expect(() => f.manager.get(l1.id, "bob")).toThrow("lease_not_owned");
  f.manager.release(l1.id, "alice"); await expect(f.manager.stop("docling-desk")).rejects.toThrow("service_busy");
  f.manager.release(l2.id, "bob"); await f.manager.stop("docling-desk"); expect(f.stops).toBe(1); expect(f.ledger.reservations()).toHaveLength(0);
});
test("expired consumer never stops active jobs; idle requires a fresh full interval", async () => {
  const f = await fixture(); await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  f.advance(400000); f.busy(1); await f.manager.tick(); f.advance(200000); await f.manager.tick(); expect(f.stops).toBe(0);
  f.busy(0); f.advance(5000); await f.manager.tick();
  for (let n = 0; n < 24; n++) { f.advance(5000); await f.manager.tick(); }
  expect(f.stops).toBe(1);
});
test("unknown activity and stop timeout retain process reservations", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  f.offline(); f.advance(500000); await f.manager.tick(); expect(f.stops).toBe(0); expect(f.ledger.reservations()).toHaveLength(1);
  f.stopFails(); await expect(f.manager.stop("docling-desk")).rejects.toThrow(); expect(f.ledger.reservations()).toHaveLength(1);
});
test("stop failure after zero-activity drain preserves reservation and marks quarantine", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  f.manager.release(l.id, "a"); f.stopFails();
  await expect(f.manager.stop("docling-desk")).rejects.toThrow("service_control_unavailable");
  expect(f.manager.status("docling-desk").state).toBe("failed");
  expect(f.ledger.reservations()).toHaveLength(1);
  await expect(f.manager.ensure("docling-desk", "a", "new", {})).rejects.toThrow("stop_unconfirmed");
});
test("failed startup returns failed lease even after positive stopped observation", async () => {
  const f = await fixture(); f.backend.start = async () => { throw new Error("startup failed"); };
  const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  expect(f.manager.get(l.id, "a").status).toBe("failed");
  expect(f.ledger.reservations()).toHaveLength(0);
  expect(f.manager.status("docling-desk").state).toBe("stopped");
});
test("unknown activity withholds endpoint and rejects additional consumers", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  f.offline(); await f.manager.tick();
  expect(f.manager.get(l.id, "a").status).toBe("starting");
  expect(f.manager.get(l.id, "a").endpoint).toBeUndefined();
  await expect(f.manager.ensure("docling-desk", "b", "new", {})).rejects.toThrow("readiness_unknown");
});
test("reconcile keeps live group, invalidates old lease, and prevents unowned adoption", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush(); await f.manager.close();
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" }); await restarted.initialize();
  expect(restarted.status("docling-desk").state).toBe("ready"); expect(() => restarted.get(l.id, "a")).toThrow("lease_not_found");
  const missing = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, journal: new LocalServiceFileJournal(join(roots.at(-1)!, "missing.json")) }); await missing.initialize();
  expect(missing.status("docling-desk").error).toBe("reconcile_quarantine"); expect(f.stops).toBe(0);
});
test("ensure waiting on stop rechecks idempotency and conflicting bodies", async () => {
  const f = await fixture(); const initial = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush();
  f.manager.release(initial.id, "a");
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const original = f.backend.stop;
  f.backend.stop = async d => { entered.resolve(); await finish.promise; await original(d); };
  const stopping = f.manager.stop("docling-desk"); await entered.promise;
  const one = f.manager.ensure("docling-desk", "a", "next", {});
  const two = f.manager.ensure("docling-desk", "a", "next", {});
  const conflict = f.manager.ensure("docling-desk", "a", "next", { ttlSeconds: 20 }).then(() => new Error("unexpected success"), e => e as Error);
  finish.resolve(); await stopping;
  const [first, second] = await Promise.all([one, two]); await f.manager.flush();
  expect(first.id).toBe(second.id); expect(f.starts).toBe(2);
  expect((await conflict).message).toBe("idempotency_conflict");
});
test("stale observation withholds existing endpoints without a timer tick", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  f.advance(16000);
  expect(f.manager.get(l.id, "a").endpoint).toBeUndefined();
  await expect(f.manager.ensure("docling-desk", "b", "k", {})).rejects.toThrow("readiness_unknown");
  await f.manager.tick(); expect(f.manager.get(l.id, "a").status).toBe("ready");
});
test("complete container crash releases reservation and permanently fails old generation leases", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush();
  const observe = f.backend.observe;
  f.backend.observe = async d => ({ ...await observe(d), state: "failed", containerIds: [], memoryUsageBytes: 0 });
  await f.manager.tick(); expect(f.ledger.reservations()).toHaveLength(0);
  expect(f.manager.get(l.id, "a").status).toBe("failed");
  f.backend.observe = observe;
  const fresh = await f.manager.ensure("docling-desk", "a", "new", {}); await f.manager.flush();
  expect(fresh.generation).toBe(l.generation + 1);
  expect(f.manager.get(l.id, "a").status).toBe("failed");
});
test("lost drain response resumes only a verified original instance", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  const drain = f.backend.drain;
  f.backend.drain = async d => { await drain(d); throw new Error("response lost"); };
  await expect(f.manager.stop("docling-desk")).rejects.toThrow();
  expect(f.manager.status("docling-desk").state).toBe("ready");
  expect((await f.backend.activity(f.definitions[0]!)).draining).toBe(false);
  expect(f.stops).toBe(0);
});
test("daemon restart detects an App restart inside unchanged containers", async () => {
  const f = await fixture(); await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush(); await f.manager.close();
  const activity = f.backend.activity;
  f.backend.activity = async d => ({ ...await activity(d), bootId: "app-replaced" });
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" });
  await restarted.initialize();
  expect(restarted.status("docling-desk").state).toBe("failed");
  await expect(restarted.stop("docling-desk")).rejects.toThrow("service_quarantined");
  expect(f.stops).toBe(0);
});
test("a blind observation gap or activity pulse resets the idle interval", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "k", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  await f.manager.tick(); f.advance(120000); await f.manager.tick(); expect(f.stops).toBe(0);
  for (let n = 0; n < 23; n++) { f.advance(5000); await f.manager.tick(); }
  f.pulse(); f.advance(5000); await f.manager.tick(); expect(f.stops).toBe(0);
  for (let n = 0; n < 24; n++) { f.advance(5000); await f.manager.tick(); }
  expect(f.stops).toBe(1);
});
test("repeated failed starts back off and persist the trial limit across daemon restart", async () => {
  const f = await fixture(); let calls = 0;
  f.backend.start = async () => { calls++; throw new Error("bad image"); };
  await f.manager.ensure("docling-desk", "a", "1", {}); await f.manager.flush();
  await expect(f.manager.ensure("docling-desk", "a", "early", {})).rejects.toThrow("startup_cooldown");
  for (const key of ["2", "3"]) { f.advance(10000); await f.manager.ensure("docling-desk", "a", key, {}); await f.manager.flush(); }
  f.advance(100000); await expect(f.manager.ensure("docling-desk", "a", "4", {})).rejects.toThrow("startup_retry_limit");
  await f.manager.close();
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" }); await restarted.initialize();
  await expect(restarted.ensure("docling-desk", "a", "5", {})).rejects.toThrow("startup_retry_limit");
  expect(calls).toBe(3);
});
test("ensure during drain cancels shutdown and preserves the current generation", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const drain = f.backend.drain;
  f.backend.drain = async d => { entered.resolve(); await finish.promise; return drain(d); };
  const result = f.manager.stop("docling-desk").then(() => "stopped", e => (e as Error).message);
  await entered.promise;
  const reused = await f.manager.ensure("docling-desk", "a", "new", {});
  expect(reused.status).toBe("starting"); finish.resolve();
  expect(await result).toBe("service_busy");
  expect(f.manager.get(reused.id, "a").status).toBe("ready");
  expect(reused.generation).toBe(l.generation); expect(f.starts).toBe(1); expect(f.stops).toBe(0);
});
test("ensure in the final observation window is rechecked before committing stop", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const observe = f.backend.observe; let calls = 0;
  f.backend.observe = async d => {
    if (++calls === 2) { entered.resolve(); await finish.promise; }
    return observe(d);
  };
  const result = f.manager.stop("docling-desk").then(() => "stopped", e => (e as Error).message);
  await entered.promise;
  const renewed = await f.manager.ensure("docling-desk", "b", "new", {}); finish.resolve();
  expect(await result).toBe("service_busy"); expect(f.stops).toBe(0);
  expect(f.manager.get(renewed.id, "b").status).toBe("ready");
});
test("changed App identity is rejected before issuing drain", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  const activity = f.backend.activity; let drains = 0;
  f.backend.activity = async d => ({ ...await activity(d), bootId: "replaced" });
  f.backend.drain = async d => { drains++; return activity(d); };
  await expect(f.manager.stop("docling-desk")).rejects.toThrow("instance_changed");
  expect(drains).toBe(0); expect(f.stops).toBe(0); expect(f.ledger.reservations()).toHaveLength(1);
});
test("an unverified replacement boot cannot become trusted through another daemon restart", async () => {
  const f = await fixture(); await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); await f.manager.close();
  const activity = f.backend.activity; let calls = 0;
  f.backend.activity = async d => ({ ...await activity(d), bootId: ++calls === 1 ? "app-1" : "unverified" });
  const second = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" });
  await second.initialize(); expect(second.status("docling-desk").state).toBe("failed"); await second.close();
  const third = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-3" });
  await third.initialize(); expect(third.status("docling-desk").state).toBe("failed");
});
test("an external drain is never automatically resumed by stop or daemon reconciliation", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  await f.backend.drain(f.definitions[0]!); let resumes = 0;
  f.backend.resume = async () => { resumes++; };
  await expect(f.manager.stop("docling-desk")).rejects.toThrow("instance_changed");
  await f.manager.close();
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" });
  await restarted.initialize();
  expect(restarted.status("docling-desk").state).toBe("failed"); expect(resumes).toBe(0); expect(f.stops).toBe(0);
});
test("daemon restart resumes its recorded drain after a failed physical stop", async () => {
  const f = await fixture(); const l = await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); f.manager.release(l.id, "a");
  f.stopFails(); await expect(f.manager.stop("docling-desk")).rejects.toThrow("service_control_unavailable");
  expect((await f.backend.activity(f.definitions[0]!)).draining).toBe(true);
  await f.manager.close();
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" });
  await restarted.initialize();
  expect(restarted.status("docling-desk").state).toBe("ready");
  expect((await f.backend.activity(f.definitions[0]!)).draining).toBe(false);
  expect(f.stops).toBe(0);
});
test("a live v1 container journal migrates to opaque v2 identity without another start or stop", async () => {
  const f = await fixture(); await f.manager.ensure("docling-desk", "a", "initial", {}); await f.manager.flush(); await f.manager.close();
  const current = await f.opts.journal.load() as { entries: Record<string, unknown>[] };
  await f.opts.journal.save({ version: 1, entries: current.entries.map(({ instanceToken: _, ...entry }) => ({ ...entry, containerIds: ["a".repeat(64), "b".repeat(64)] })) });
  const restarted = new LocalServiceManager(f.definitions, f.backend, { ...f.opts, bootEpoch: "daemon-2" });
  await restarted.initialize();
  expect(restarted.status("docling-desk").state).toBe("ready");
  expect(await f.opts.journal.load()).toMatchObject({ version: 2 });
  expect(f.starts).toBe(1); expect(f.stops).toBe(0);
});
