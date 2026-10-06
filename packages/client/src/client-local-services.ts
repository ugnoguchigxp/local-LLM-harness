import { localServiceLeaseSchema, localServiceListSchema, localServiceStatusSchema, type LocalServiceLease } from "@larm/core";

/** Scoped service token is independent of Provider and management credentials. */
export class ClientLocalServices {
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid local service base URL");
  }
  private async request(path: string, method = "GET", body?: unknown, key?: string, budgetMs?: number): Promise<Response> {
    const r = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      method, signal: AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 10000, budgetMs ?? Infinity)), redirect: "error",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) { await r.body?.cancel(); throw new Error(`local service request failed: ${r.status}`); }
    return r;
  }
  private async json(r: Response): Promise<unknown> {
    const reader = r.body?.getReader(); if (!reader) throw new Error("empty local service response");
    const decoder = new TextDecoder(); let result = "", bytes = 0;
    try {
      for (;;) {
        const v = await reader.read(); if (v.done) break;
        bytes += v.value.byteLength; if (bytes > 131072) throw new Error("local service response too large");
        result += decoder.decode(v.value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); }
  }
  private sameBinding(value: LocalServiceLease, expected: LocalServiceLease): LocalServiceLease {
    if (value.id !== expected.id || value.serviceId !== expected.serviceId || value.generation !== expected.generation || value.bootEpoch !== expected.bootEpoch || value.revision !== expected.revision) throw new Error("local service binding changed");
    return value;
  }
  async list() { return localServiceListSchema.parse(await this.json(await this.request("/v1/local-services"))); }
  async status(service: string) {
    const result = localServiceStatusSchema.parse(await this.json(await this.request(`/v1/local-services/${encodeURIComponent(service)}`)));
    if (result.id !== service) throw new Error("local service identity mismatch");
    return result;
  }
  async ensure(service: string, options: { ttlSeconds?: number; idempotencyKey?: string; catalogRevision?: string } = {}): Promise<LocalServiceLease> {
    const result = localServiceLeaseSchema.parse(await this.json(await this.request(`/v1/local-services/${encodeURIComponent(service)}/leases`, "POST", {
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      ...(options.catalogRevision === undefined ? {} : { catalogRevision: options.catalogRevision }),
    }, options.idempotencyKey ?? crypto.randomUUID())));
    if (result.serviceId !== service || (options.catalogRevision && result.revision !== options.catalogRevision)) throw new Error("local service identity mismatch");
    return result;
  }
  async resolve(lease: string, budgetMs?: number): Promise<LocalServiceLease> {
    const result = localServiceLeaseSchema.parse(await this.json(await this.request(`/v1/local-service-leases/${encodeURIComponent(lease)}`, "GET", undefined, undefined, budgetMs)));
    if (result.id !== lease) throw new Error("local service identity mismatch");
    return result;
  }
  async renew(lease: LocalServiceLease): Promise<LocalServiceLease> {
    return this.sameBinding(localServiceLeaseSchema.parse(await this.json(await this.request(`/v1/local-service-leases/${encodeURIComponent(lease.id)}/renew`, "POST", { generation: lease.generation, bootEpoch: lease.bootEpoch }))), lease);
  }
  async release(lease: string): Promise<void> { await this.request(`/v1/local-service-leases/${encodeURIComponent(lease)}`, "DELETE"); }
  async waitUntilReady(lease: LocalServiceLease, timeoutMs = 180000): Promise<LocalServiceLease> {
    const deadline = Date.now() + timeoutMs;
    while (lease.status === "starting" && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(250, deadline - Date.now())));
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      lease = this.sameBinding(await this.resolve(lease.id, remaining), lease);
    }
    if (lease.status !== "ready") throw new Error(`local service unavailable: ${lease.status}`);
    return lease;
  }
}
