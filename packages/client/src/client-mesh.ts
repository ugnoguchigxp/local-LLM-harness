import { meshGenerationRequestSchema, meshJobSchema, meshAssetSchema, meshAssetListSchema, meshQuerySchema,
  meshAssetPatchSchema, meshIdSchema, meshJobIdSchema, type MeshGenerationRequestInput, type MeshQuery } from "@larm/core";

/** Saved media API. Use the Control API token; Provider credentials do not authorize it. */
export class ClientMesh {
  constructor(private readonly request: (path: string, init?: RequestInit) => Promise<Response>) {}
  async generate(input: MeshGenerationRequestInput, idempotencyKey: string, signal?: AbortSignal) {
    return meshJobSchema.parse(await (await this.request("/v1/3d/generations", { method: "POST", signal,
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(meshGenerationRequestSchema.parse(input)) })).json());
  }
  async job(id: string, signal?: AbortSignal) { return meshJobSchema.parse(await (await this.request(`/v1/3d/generations/${meshJobIdSchema.parse(id)}`, { signal })).json()); }
  async cancel(id: string, signal?: AbortSignal) { return meshJobSchema.parse(await (await this.request(`/v1/3d/generations/${meshJobIdSchema.parse(id)}`, { method: "DELETE", signal })).json()); }
  async events(id: string, signal?: AbortSignal) { return this.request(`/v1/3d/generations/${meshJobIdSchema.parse(id)}/events`, { signal }); }
  async list(input: Partial<MeshQuery> = {}, signal?: AbortSignal) {
    const q = meshQuerySchema.parse(input), params = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) if (value !== undefined) params.set(key, Array.isArray(value) ? value.join(",") : String(value));
    return meshAssetListSchema.parse(await (await this.request(`/v1/3d/assets?${params}`, { signal })).json());
  }
  async get(id: string, signal?: AbortSignal) { return meshAssetSchema.parse(await (await this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}`, { signal })).json()); }
  async patch(id: string, patch: { title?: string; tags?: string[] }, signal?: AbortSignal) {
    return meshAssetSchema.parse(await (await this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}`, { method: "PATCH", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(meshAssetPatchSchema.parse(patch)) })).json());
  }
  async delete(id: string, signal?: AbortSignal) { await this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}`, { method: "DELETE", signal }); }
  async content(id: string, signal?: AbortSignal) { return this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}/content`, { signal }); }
  async source(id: string, signal?: AbortSignal) { return this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}/source`, { signal }); }
  async metadata(id: string, signal?: AbortSignal) { return meshAssetSchema.parse(await (await this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}/metadata`, { signal })).json()); }
  async preview(id: string, signal?: AbortSignal) { return this.request(`/v1/3d/assets/${meshIdSchema.parse(id)}/preview`, { signal }); }
}
