import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  legacyServiceInstanceToken, localServiceActivitySchema,
  type LocalServiceActivity, type LocalServiceDefinition, type LocalServiceBackend,
} from "@larm/core";

export const localServiceObservationSchema = z.object({
  serviceId: z.string(), release: z.string(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.string().datetime(),
  state: z.enum(["stopped", "running", "failed", "unknown"]),
  containerIds: z.array(z.string().regex(/^[a-f0-9]{12,64}$/)).max(2),
  memoryUsageBytes: z.number().int().nonnegative(),
  error: z.string().max(128).optional(),
}).strict();
export type LocalServiceObservation = z.infer<typeof localServiceObservationSchema>;
export type { LocalServiceBackend } from "@larm/core";
export async function systemctl(args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/systemctl", args, { shell: false, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("unit_control_timeout")); }, timeoutMs);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("unit_control_failed")); });
  });
}
export async function boundedJson(r: Response): Promise<unknown> {
  const reader = r.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const decoder = new TextDecoder();
  let result = "", bytes = 0;
  try {
    for (;;) {
      const v = await reader.read();
      if (v.done) break;
      bytes += v.value.byteLength;
      if (bytes > 16384) throw new Error("response_too_large");
      result += decoder.decode(v.value, { stream: true });
    }
    result += decoder.decode();
  } finally { await reader.cancel(); }
  return JSON.parse(result);
}
export class LocalServiceSystemdBackend implements LocalServiceBackend {
  constructor(protected readonly options: {
    secretRoot: string; observationRoot: string; now?: () => number;
    fetch?: typeof fetch; control?: (args: string[], timeoutMs: number) => Promise<void>;
  }) {}
  async start(d: LocalServiceDefinition): Promise<void> {
    if (d.backend !== "systemd-container-group") throw new Error("backend_mismatch");
    const deadline = Date.now() + d.readiness.timeoutSeconds * 1000;
    const o = await this.observe(d);
    if (!o.stopConfirmed || !["stopped", "failed"].includes(o.state)) throw new Error("start_requires_stopped_group");
    const control = this.options.control ?? systemctl;
    // RemainAfterExit can stay active after the backing containers have exited.
    // Reset only a positively observed empty group before a new activation.
    await control(["stop", d.deployment.unit], Math.min(d.lifecycle.gracefulStopSeconds * 1000, Math.max(1, deadline - Date.now())));
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("startup_timeout");
    await control(["start", d.deployment.unit], remaining);
  }
  async stop(d: LocalServiceDefinition): Promise<void> {
    if (d.backend !== "systemd-container-group") throw new Error("backend_mismatch");
    const control = this.options.control ?? systemctl, deadline = Date.now() + d.lifecycle.gracefulStopSeconds * 1000;
    // A failed/inactive supervising unit does not execute ExecStop. The fixed
    // one-shot stop unit must run the guarded helper regardless of that state.
    await control(["start", d.deployment.stopUnit], d.lifecycle.gracefulStopSeconds * 1000);
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("stop_timeout");
    await control(["stop", d.deployment.unit], remaining);
  }
  async observe(d: LocalServiceDefinition): Promise<Awaited<ReturnType<LocalServiceBackend["observe"]>>> {
    if (d.backend !== "systemd-container-group") throw new Error("backend_mismatch");
    const raw = await readFile(`${this.options.observationRoot}/${d.id}.json`, "utf8");
    if (raw.length > 16384) throw new Error("observation_too_large");
    const o = localServiceObservationSchema.parse(JSON.parse(raw));
    const now = this.options.now?.() ?? Date.now(), age = now - Date.parse(o.observedAt);
    if (o.serviceId !== d.id || o.release !== d.deployment.release || o.manifestDigest !== d.deployment.manifestDigest || age < 0 || age > d.activity.staleAfterSeconds * 1000) throw new Error("observation_untrusted");
    if (new Set(o.containerIds).size !== o.containerIds.length) throw new Error("group_duplicate_identity");
    if (o.state === "running" && o.containerIds.length !== 2) throw new Error("group_incomplete");
    if (o.state === "stopped" && o.containerIds.length !== 0) throw new Error("group_not_stopped");
    return { ...o, instanceToken: legacyServiceInstanceToken(o.containerIds), stopConfirmed: o.containerIds.length === 0 && ["stopped", "failed"].includes(o.state) };
  }
  private async request(d: LocalServiceDefinition, path: string, method = "GET", body?: unknown): Promise<unknown> {
    const token = (await readFile(`${this.options.secretRoot}/${d.activity.secretRef}`, "utf8")).trim();
    if (token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error("invalid_lifecycle_secret");
    const r = await (this.options.fetch ?? fetch)(`${d.deployment.endpoint}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) { await r.body?.cancel(); throw new Error("activity_unavailable"); }
    return boundedJson(r);
  }
  private checked(d: LocalServiceDefinition, raw: unknown): LocalServiceActivity {
    const a = localServiceActivitySchema.parse(raw), age = (this.options.now?.() ?? Date.now()) - Date.parse(a.observedAt);
    if (age < 0 || age > d.activity.staleAfterSeconds * 1000) throw new Error("activity_stale");
    return a;
  }
  async activity(d: LocalServiceDefinition) { return this.checked(d, await this.request(d, "/internal/larm/activity")); }
  async drain(d: LocalServiceDefinition) { return this.checked(d, await this.request(d, "/internal/larm/drain", "POST", {})); }
  async resume(d: LocalServiceDefinition, token: string) { await this.request(d, "/internal/larm/resume", "POST", { drainToken: token }); }
  async ready(d: LocalServiceDefinition): Promise<boolean> {
    try {
      const r = await (this.options.fetch ?? fetch)(`${d.deployment.endpoint}${d.backend === "systemd-process" ? d.readiness.path : "/health/ready"}`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (!r.ok) { await r.body?.cancel(); return false; }
      const body = await boundedJson(r);
      if (d.backend === "systemd-container-group") return z.object({ status: z.literal("ready"), capabilities: z.object({ source_management: z.literal(true) }) }).safeParse(body).success;
      const parsed = z.object({ status: z.string(), capabilities: z.record(z.string(), z.boolean()).optional() }).safeParse(body);
      return parsed.success && parsed.data.status === d.readiness.status && Object.entries(d.readiness.capabilities).every(([k, v]) => parsed.data.capabilities?.[k] === v);
    } catch { return false; }
  }
}
