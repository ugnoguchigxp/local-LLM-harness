import {
  computeEnvironmentSchema, computeJobSchema, computeReceiptSchema, computeIdSchema,
  type ComputeRequestInput,
} from "@larm/core";

type Options = { signal?: AbortSignal };
type Request = (path: string, init: RequestInit) => Promise<Response>;

/** Eumenes-facing CPU domain client. Mutations are sent exactly once. */
export class ClientCompute {
  constructor(private readonly request: Request) {}
  async environment(options: Options = {}) {
    return computeEnvironmentSchema.parse(await (await this.request("/v1/compute/environment", options)).json());
  }
  async submit(body: ComputeRequestInput, idempotencyKey: string, options: Options = {}) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new Error("A stable compute Idempotency-Key is required");
    return computeReceiptSchema.parse(await (await this.request("/v1/compute/jobs", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body), signal: options.signal,
    })).json());
  }
  async get(jobId: string, options: Options = {}) {
    return computeJobSchema.parse(await (await this.request(`/v1/compute/jobs/${computeIdSchema.parse(jobId)}`, options)).json());
  }
  async cancel(jobId: string, options: Options = {}) {
    return computeJobSchema.parse(await (await this.request(`/v1/compute/jobs/${computeIdSchema.parse(jobId)}/cancel`, { method: "POST", ...options })).json());
  }
  async delete(jobId: string, options: Options = {}) {
    const response = await this.request(`/v1/compute/jobs/${computeIdSchema.parse(jobId)}`, { method: "DELETE", ...options });
    return response.status === 204 ? undefined : computeJobSchema.parse(await response.json());
  }
  artifact(jobId: string, artifactId: string, options: Options = {}) {
    return this.request(`/v1/compute/jobs/${computeIdSchema.parse(jobId)}/artifacts/${computeIdSchema.parse(artifactId)}`, options);
  }
}
