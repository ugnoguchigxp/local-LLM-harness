import { LarmApiError } from "./errors";
import { imageImportReceiptSchema, imageImportRequestIdSchema, imageArtifactSchema, imageArtifactListSchema } from "@larm/core";

/** Persist the UUID before upload. A timeout is resolved by receipt or identical resend. */
export class ClientImages {
  constructor(private readonly request: (path: string, init?: RequestInit) => Promise<Response>) {}
  async import(file: Blob, requestId: string, signal?: AbortSignal) {
    imageImportRequestIdSchema.parse(requestId);
    const body = new FormData(); body.append("file", file, "image");
    try { return imageImportReceiptSchema.parse(await (await this.request("/v1/image-artifacts/imports", {
      method: "POST", headers: { "idempotency-key": requestId }, body, signal,
    })).json()); } catch (error) {
      if (error instanceof LarmApiError) {
        const receipt = imageImportReceiptSchema.safeParse(error.responseBody);
        if (receipt.success && receipt.data.status === "failed") throw new LarmApiError(error.status, receipt.data.error.code, receipt.data.error.message, receipt.data);
      }
      throw error;
    }
  }
  async receipt(requestId: string, signal?: AbortSignal) {
    return imageImportReceiptSchema.parse(await (await this.request(`/v1/image-imports/${imageImportRequestIdSchema.parse(requestId)}`, { signal })).json());
  }
  async list(signal?: AbortSignal) { return imageArtifactListSchema.parse(await (await this.request("/v1/image-artifacts", { signal })).json()); }
  async get(id: string, signal?: AbortSignal) { return imageArtifactSchema.parse(await (await this.request(`/v1/image-artifacts/${encodeURIComponent(id)}`, { signal })).json()); }
  async content(id: string, signal?: AbortSignal) { return this.request(`/v1/image-artifacts/${encodeURIComponent(id)}/content`, { signal }); }
  async delete(id: string, signal?: AbortSignal) { await this.request(`/v1/image-artifacts/${encodeURIComponent(id)}`, { method: "DELETE", signal }); }
}
