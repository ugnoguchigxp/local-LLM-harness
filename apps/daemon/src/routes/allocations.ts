import { Hono } from "hono";
import {
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  type Allocation,
} from "@larm/core";
import type { ControlPlane } from "../controller";
import { secretMatches } from "../app-auth";
import {
  errorBody,
  normalizedAllocationRequestHash,
  publicAllocation,
  readJson,
} from "../app-http";

type AllocationApiResult = {
  status: 200 | 202 | 400 | 403 | 404 | 409 | 503;
  body: unknown;
};

export function registerAllocationRoutes(app: Hono, options: {
  control: ControlPlane;
  managementToken?: string;
  maxBodyBytes: number;
  idempotencyTtlMs: number;
  idempotencyLimit: number;
  now?: () => number;
}): void {
  const idempotency = new Map<string, {
    requestHash: string;
    result: Promise<AllocationApiResult>;
    expiresAt: number;
    settled: boolean;
  }>();
  const pruneIdempotency = () => {
    const now = options.now?.() ?? Date.now();
    for (const [key, entry] of idempotency) {
      if (entry.settled && entry.expiresAt <= now) idempotency.delete(key);
    }
  };

  app.post("/v1/allocations", async (c) => {
    const parsed = allocationRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation request"), 400);
    }
    if (parsed.data.deploymentPolicy === "allow-listed") {
      if (!options.managementToken) {
        return c.json(errorBody("management_not_configured", "allow-listed deployment is disabled"), 503);
      }
      if (!secretMatches(c.req.header("x-larm-management-token"), options.managementToken)) {
        return c.json(errorBody("forbidden", "valid management token required for deployment"), 403);
      }
    }
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      return c.json(errorBody("bad_request", "Idempotency-Key is invalid"), 400);
    }
    const requestHash = normalizedAllocationRequestHash(parsed.data);
    if (idempotencyKey !== undefined) {
      pruneIdempotency();
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return c.json(errorBody(
            "idempotency_conflict",
            "Idempotency-Key was already used for a different allocation request",
          ), 409);
        }
        const replay = await existing.result;
        c.header("x-larm-idempotent-replay", "true");
        return c.json(replay.body, replay.status);
      }
      if (idempotency.size >= options.idempotencyLimit) {
        return c.json(errorBody(
          "idempotency_capacity",
          "idempotency result capacity is temporarily exhausted",
        ), 503);
      }
    }
    const allocationResult = (async (): Promise<AllocationApiResult> => {
      const result = await options.control.allocate(parsed.data);
      return {
        status: result.status,
        body: "id" in result.body ? publicAllocation(result.body as Allocation) : result.body,
      };
    })();
    const entry = idempotencyKey !== undefined
      ? {
        requestHash,
        result: allocationResult,
        expiresAt: (options.now?.() ?? Date.now()) + options.idempotencyTtlMs,
        settled: false,
      }
      : undefined;
    if (idempotencyKey !== undefined && entry) {
      idempotency.set(idempotencyKey, entry);
      void allocationResult.then(
        (result) => {
          entry.settled = true;
          if (result.status !== 200 && result.status !== 202 && idempotency.get(idempotencyKey) === entry) {
            idempotency.delete(idempotencyKey);
          }
        },
        () => {
          entry.settled = true;
          if (idempotency.get(idempotencyKey) === entry) idempotency.delete(idempotencyKey);
        },
      );
    }
    const result = await allocationResult;
    return c.json(result.body, result.status);
  });

  app.get("/v1/allocations/:id", (c) => {
    const allocation = options.control.getAllocation(c.req.param("id"));
    if (!allocation) {
      const missing = options.control.allocationLookupError(c.req.param("id"));
      return c.json(missing.body, missing.status);
    }
    return c.json(publicAllocation(allocation));
  });

  app.post("/v1/allocations/:id/renew", async (c) => {
    const parsed = allocationRenewRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation renewal"), 400);
    }
    const result = options.control.renewAllocation(c.req.param("id"), parsed.data.ttlSeconds);
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409 | 503);
  });

  app.post("/v1/allocations/:id/resolve", async (c) => {
    const parsed = allocationResolveRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = options.control.resolveAllocation(c.req.param("id"), parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 409 | 503);
  });

  app.delete("/v1/allocations/:id", async (c) => {
    const result = await options.control.releaseAllocation(c.req.param("id"));
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409);
  });
}
