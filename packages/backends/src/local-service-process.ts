import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { z } from "zod";
import type { LocalServiceBackend, LocalServiceDefinition, LocalServiceStopExpectation } from "@larm/core";
import { LocalServiceSystemdBackend, systemctl } from "./local-service-systemd";

export const processServiceObservationSchema = z.object({
  serviceId: z.string(), release: z.string(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.string().datetime(),
  state: z.enum(["stopped", "running", "failed", "unknown"]),
  instanceToken: z.string().regex(/^[a-f0-9]{64}$/).nullable(), stopConfirmed: z.boolean(),
  memoryUsageBytes: z.number().int().nonnegative(),
  memory: z.object({ anon: z.number().int().nonnegative(), file: z.number().int().nonnegative(), shmem: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  error: z.string().max(128).optional(),
}).strict().refine(o => !o.stopConfirmed || (o.instanceToken === null && ["stopped", "failed"].includes(o.state)), "stop evidence conflicts with live instance")
  .refine(o => o.state !== "running" || (!!o.instanceToken && !o.stopConfirmed), "running requires identity")
  .refine(o => o.state !== "stopped" || o.stopConfirmed, "stopped requires evidence")
  .refine(o => o.memoryUsageBytes === o.memory.anon, "admission usage must be anonymous memory");

/** OS operations are fixed units; only a guarded expectation crosses the privilege boundary. */
export class SystemdProcessBackend extends LocalServiceSystemdBackend {
  constructor(options: ConstructorParameters<typeof LocalServiceSystemdBackend>[0] & { requestRoot: string }) {
    super(options); this.requestRoot = options.requestRoot;
  }
  private readonly requestRoot: string;
  override async observe(d: LocalServiceDefinition): Promise<Awaited<ReturnType<LocalServiceBackend["observe"]>>> {
    if (d.backend !== "systemd-process") throw new Error("backend_mismatch");
    await (this.options.control ?? systemctl)(["start", d.deployment.observeUnit], 10000);
    const raw = await readFile(`${this.options.observationRoot}/${d.id}.json`, "utf8");
    if (raw.length > 16384) throw new Error("observation_too_large");
    const o = processServiceObservationSchema.parse(JSON.parse(raw));
    const age = (this.options.now?.() ?? Date.now()) - Date.parse(o.observedAt);
    if (o.serviceId !== d.id || o.release !== d.deployment.release || o.manifestDigest !== d.deployment.manifestDigest || age < 0 || age > d.activity.staleAfterSeconds * 1000) throw new Error("observation_untrusted");
    return o;
  }
  override async start(d: LocalServiceDefinition): Promise<void> {
    if (d.backend !== "systemd-process") throw new Error("backend_mismatch");
    const o = await this.observe(d);
    if (!o.stopConfirmed || o.instanceToken) throw new Error("start_requires_stopped_group");
    const control = this.options.control ?? systemctl;
    // The entry oneshot may remain active after members exit. Reset only with empty evidence.
    await control(["stop", d.deployment.unit], 10000);
    await control(["start", d.deployment.unit], d.readiness.timeoutSeconds * 1000);
  }
  override async stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation): Promise<void> {
    if (d.backend !== "systemd-process" || !expected) throw new Error("stop_expectation_required");
    z.object({ instanceToken: z.string().regex(/^[a-f0-9]{64}$/), appBootId: z.string().min(1).max(128), drainToken: z.string().min(1).max(128) }).strict().parse(expected);
    await mkdir(this.requestRoot, { recursive: true, mode: 0o700 });
    const path = `${this.requestRoot}/${d.id}.json`, temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ ...expected, manifestDigest: d.deployment.manifestDigest, requestedAt: new Date(this.options.now?.() ?? Date.now()).toISOString() }), { mode: 0o600, flag: "wx" });
      await rename(temp, path);
      await (this.options.control ?? systemctl)(["start", d.deployment.stopUnit], d.lifecycle.gracefulStopSeconds * 1000);
    } finally { await rm(temp, { force: true }); await rm(path, { force: true }); }
  }
}

export class LocalServiceRoutingBackend implements LocalServiceBackend {
  constructor(private readonly container: LocalServiceBackend, private readonly process: LocalServiceBackend) {}
  private backend(d: LocalServiceDefinition) { return d.backend === "systemd-process" ? this.process : this.container; }
  start(d: LocalServiceDefinition) { return this.backend(d).start(d); }
  stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation) { return this.backend(d).stop(d, expected); }
  observe(d: LocalServiceDefinition) { return this.backend(d).observe(d); }
  ready(d: LocalServiceDefinition) { return this.backend(d).ready(d); }
  activity(d: LocalServiceDefinition) { return this.backend(d).activity(d); }
  drain(d: LocalServiceDefinition) { return this.backend(d).drain(d); }
  resume(d: LocalServiceDefinition, token: string) { return this.backend(d).resume(d, token); }
}
