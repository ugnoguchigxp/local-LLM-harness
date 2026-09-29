import {
  allocationRequestSchema,
  publicAllocationSchema,
  type AllocationRequestInput,
  type PublicAllocation,
} from "@larm/core";
import { allocationTimeout, createIdempotencyKey, delay, validatePollingOptions } from "./client-helpers";
import { LarmApiError } from "./errors";
import type { ClientRequestOptions } from "./client-context-api";

type JsonSchema<T> = { parse(input: unknown): T };
type Request = (
  path: string,
  init: RequestInit,
  management?: boolean,
  timeoutMs?: number,
) => Promise<Response>;

export class ClientAllocationApi {
  constructor(private readonly deps: {
    request: Request;
    parseJson: <T>(response: Response, schema: JsonSchema<T>) => Promise<T>;
    random?: () => string;
    timeoutMs: number;
  }) {}

  async allocate(request: AllocationRequestInput, options: ClientRequestOptions = {}): Promise<PublicAllocation> {
    const normalized = allocationRequestSchema.parse(request);
    const response = await this.deps.request("/v1/allocations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(normalized),
      signal: options.signal,
    }, options.management ?? normalized.deploymentPolicy === "allow-listed");
    return this.deps.parseJson(response, publicAllocationSchema);
  }

  async getAllocation(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    return await this.getAllocationWithin(id, signal, this.deps.timeoutMs);
  }

  private async getAllocationWithin(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PublicAllocation> {
    const response = await this.deps.request(
      `/v1/allocations/${encodeURIComponent(id)}`,
      { signal },
      false,
      timeoutMs,
    );
    return this.deps.parseJson(response, publicAllocationSchema);
  }

  async waitUntilReady(
    allocation: PublicAllocation,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAllocation> {
    const timeoutMs = options.timeoutMs ?? this.deps.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    validatePollingOptions(timeoutMs, pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    let current = allocation;
    while (current.status === "waiting" || current.status === "pending") {
      if (Date.now() >= deadline) {
        throw new LarmApiError(
          408,
          "allocation_timeout",
          `allocation ${current.id} did not become ready before the client deadline`,
          current,
        );
      }
      await delay(
        Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
        options.signal,
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw allocationTimeout(current);
      }
      try {
        current = await this.getAllocationWithin(current.id, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw allocationTimeout(current);
        throw error;
      }
    }
    if (current.status !== "ready") {
      throw new LarmApiError(409, current.error?.code ?? "allocation_not_ready", current.error?.message
        ?? `allocation ${current.id} ended as ${current.status}`, current);
    }
    return current;
  }

  async renew(id: string, ttlSeconds = 300, signal?: AbortSignal): Promise<PublicAllocation> {
    const response = await this.deps.request(`/v1/allocations/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds }),
      signal,
    });
    return this.deps.parseJson(response, publicAllocationSchema);
  }

  async release(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    const response = await this.deps.request(`/v1/allocations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    return this.deps.parseJson(response, publicAllocationSchema);
  }
}
