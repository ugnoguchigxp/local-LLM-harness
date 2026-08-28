import type { ClusterState, Registry, RuntimeProtocol } from "@larm/core";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
  getRuntime,
  selectProtocolBinding,
  type Allocation,
  type AllocationRequest,
} from "@larm/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ControlEvent, ControlPlane } from "./controller";
import type { ArtifactManager } from "./artifact-manager";
import type { MetricsRegistry, RequestTracker } from "./metrics";
import type { DaemonIdentity } from "./identity";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import { readBodyLimited, RequestBodyError } from "./http-body";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AppDeps = {
  registry: Registry;
  getState: () => ClusterState;
  control: ControlPlane;
  apiToken?: string;
  managementToken?: string;
  artifactManager?: ArtifactManager;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  gatewayFetch?: FetchLike;
  controlMaxBodyBytes?: number;
  gatewayMaxBodyBytes?: number;
  gatewayTimeoutMs?: number;
  speechMaxBodyBytes?: number;
  stateMaxAgeMs?: number;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
  identity?: DaemonIdentity;
  executionGate?: ExecutionGate;
  idempotencyTtlMs?: number;
  idempotencyLimit?: number;
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return actual !== undefined && timingSafeEqual(actualDigest, expectedDigest);
}

export function publicRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    protocol: runtime.protocol,
    backend: runtime.backend,
    node: runtime.node,
    policy: runtime.policy,
    resources: runtime.resources,
    deployment: runtime.deployment,
  };
}

export function publicAllocation(allocation: Allocation) {
  return {
    ...allocation,
    bindings: allocation.bindings.map(({ endpoint: _endpoint, ...binding }) => binding),
  };
}

async function readJson(c: { req: { raw: Request } }, maxBytes: number): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBodyLimited(c.req.raw, maxBytes);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      throw err;
    }
    throw new RequestBodyError("bad_request", "request body could not be read", 400);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestBodyError("bad_request", "request body must be valid UTF-8 JSON", 400);
  }
}

function normalizedAllocationRequestHash(request: AllocationRequest): string {
  const normalized = {
    ...request,
    requirements: [...request.requirements].sort((left, right) => {
      const leftKey = `${left.capability}\0${left.route}`;
      const rightKey = `${right.capability}\0${right.route}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const controlMaxBodyBytes = deps.controlMaxBodyBytes ?? 64 * 1024;
  const identity = deps.identity ?? {
    version: "test",
    configRevision: "test",
    bootEpoch: deps.control.getBootEpoch(),
  };
  const executionGate = deps.executionGate ?? new ExecutionGate({
    now: deps.now,
    onState: (runtime, state) => {
      deps.metrics?.setGauge("execution_active", { runtime }, state.active);
      deps.metrics?.setGauge("execution_queued", { runtime }, state.queued);
    },
    onEvent: (event) => {
      deps.metrics?.record(event);
      deps.onEvent?.(event);
    },
  });
  type AllocationApiResult = {
    status: 200 | 202 | 400 | 403 | 404 | 409 | 503;
    body: unknown;
  };
  const idempotency = new Map<string, {
    requestHash: string;
    result: Promise<AllocationApiResult>;
    expiresAt: number;
    settled: boolean;
  }>();
  const pruneIdempotency = () => {
    const now = deps.now?.() ?? Date.now();
    for (const [key, entry] of idempotency) {
      if (entry.settled && entry.expiresAt <= now) {
        idempotency.delete(key);
      }
    }
  };

  app.onError((err, c) => {
    if (err instanceof RequestBodyError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    console.error(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json(errorBody("internal_error", "internal server error"), 500);
  });

  app.use("*", async (c, next) => {
    c.header("x-larm-boot-epoch", identity.bootEpoch);
    const publicPath = c.req.path === "/health" || c.req.path === "/ready";
    if (deps.apiToken && !publicPath) {
      const expected = `Bearer ${deps.apiToken}`;
      if (!secretMatches(c.req.header("authorization"), expected)) {
        return c.json(errorBody("unauthorized", "valid bearer token required"), 401);
      }
    }
    await next();
  });

  const requireManagement: MiddlewareHandler = async (c, next) => {
    if (!deps.managementToken) {
      return c.json(errorBody("management_not_configured", "management API is disabled"), 503);
    }
    if (!secretMatches(c.req.header("x-larm-management-token"), deps.managementToken)) {
      return c.json(errorBody("forbidden", "valid management token required"), 403);
    }
    if (deps.control.isDraining()) {
      return c.json(errorBody("draining", "control plane is draining"), 503);
    }
    await next();
  };
  app.use("/v1/artifacts/*", requireManagement);
  app.use("/v1/deployments/*", requireManagement);
  app.use("/v1/artifact-operations/*", requireManagement);

  const handleGateway = async (
    c: Context,
    options: {
      protocol: RuntimeProtocol;
      upstreamPath: string;
      bodyMode: "buffered" | "stream" | "none";
      maxBodyBytes: number;
      capability?: string;
    },
  ): Promise<Response> => {
    if (deps.control.isDraining()) {
      return c.json(errorBody("draining", "control plane is draining"), 503);
    }
    const allocationId = c.req.header("x-larm-allocation-id");
    if (allocationId === undefined) {
      return c.json(errorBody("allocation_required", "x-larm-allocation-id is required"), 400);
    }
    if (!/^alloc_[a-zA-Z0-9._-]{1,186}$/.test(allocationId)) {
      return c.json(errorBody("bad_request", "x-larm-allocation-id is invalid"), 400);
    }
    const requestedCapability = options.capability ?? c.req.header("x-larm-capability");
    if (
      requestedCapability !== undefined
      && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(requestedCapability)
    ) {
      return c.json(errorBody("bad_request", "x-larm-capability is invalid"), 400);
    }
    const allocation = deps.control.getAllocation(allocationId);
    if (!allocation) {
      const missing = deps.control.allocationLookupError(allocationId);
      return c.json(missing.body, missing.status);
    }
    const selected = selectProtocolBinding({
      registry: deps.registry,
      allocation,
      protocol: options.protocol,
      capability: requestedCapability,
    });
    if (!selected.ok) {
      const status = selected.reason === "capability_not_allocated"
        || selected.reason === "protocol_not_allocated"
        ? 404
        : 409;
      return c.json(errorBody(selected.reason, selected.reason.replaceAll("_", " ")), status);
    }
    const resolved = deps.control.resolveAllocation(allocationId, selected.binding.capability);
    if (resolved.status !== 200 || !("endpoint" in resolved.body)) {
      return c.json(resolved.body, resolved.status as 404 | 409 | 503);
    }
    const runtime = getRuntime(deps.registry, resolved.body.runtime);
    if (!runtime || runtime.protocol !== options.protocol) {
      return c.json(errorBody("protocol_mismatch", "allocated runtime protocol does not match"), 409);
    }

    return await proxyGateway({
      request: c.req.raw,
      allocationId,
      protocol: options.protocol,
      upstreamPath: options.upstreamPath,
      runtime,
      bodyMode: options.bodyMode,
      maxBodyBytes: options.maxBodyBytes,
      timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
      bootEpoch: identity.bootEpoch,
      executionGate,
      fetchImpl: deps.gatewayFetch,
      metrics: deps.metrics,
      requestTracker: deps.requestTracker,
      lifecycleSignal: deps.control.getAllocationSignal(allocationId),
      now: deps.now,
      random: deps.random,
      onEvent: deps.onEvent,
      revalidate: () => {
        const current = deps.control.resolveAllocation(allocationId, selected.binding.capability);
        if (current.status !== 200 || !("endpoint" in current.body)) {
          return { ok: false, status: current.status, body: current.body };
        }
        return { ok: true, binding: current.body };
      },
    });
  };

  app.get("/health", (c) => c.json({
    status: "ok",
    version: identity.version,
    configRevision: identity.configRevision,
    bootEpoch: identity.bootEpoch,
  }));

  app.get("/ready", (c) => {
    const generated = Date.parse(deps.getState().generatedAt);
    const age = (deps.now?.() ?? Date.now()) - generated;
    if (deps.control.isDraining()) {
      return c.json({ status: "draining" }, 503);
    }
    if (!Number.isFinite(age) || age < 0 || age > (deps.stateMaxAgeMs ?? 10_000)) {
      return c.json({ status: "stale", ageMs: age }, 503);
    }
    return c.json({ status: "ready" });
  });

  app.get("/metrics", (c) => c.text(deps.metrics?.render() ?? ""));

  app.get("/runtimes", (c) =>
    c.json({
      runtimes: deps.registry.runtimes.map(publicRuntime),
    }),
  );

  app.get("/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(publicRuntime(runtime));
  });

  app.get("/state", (c) => c.json(deps.getState()));

  app.get("/operations/:id", (c) => {
    const operation = deps.control.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "operation not found"), 404);
    }
    return c.json(operation);
  });

  app.get("/v1/operations/:id", (c) => {
    const operation = deps.control.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "operation not found"), 404);
    }
    return c.json(operation);
  });

  app.post("/v1/allocations", async (c) => {
    const parsed = allocationRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation request"), 400);
    }
    if (parsed.data.deploymentPolicy === "allow-listed") {
      if (!deps.managementToken) {
        return c.json(errorBody("management_not_configured", "allow-listed deployment is disabled"), 503);
      }
      if (!secretMatches(c.req.header("x-larm-management-token"), deps.managementToken)) {
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
      if (idempotency.size >= (deps.idempotencyLimit ?? 1_000)) {
        return c.json(errorBody(
          "idempotency_capacity",
          "idempotency result capacity is temporarily exhausted",
        ), 503);
      }
    }
    const allocationResult = (async (): Promise<AllocationApiResult> => {
      const result = await deps.control.allocate(parsed.data);
      return {
        status: result.status,
        body: "id" in result.body ? publicAllocation(result.body as Allocation) : result.body,
      };
    })();
    const entry = idempotencyKey !== undefined
      ? {
        requestHash,
        result: allocationResult,
        expiresAt: (deps.now?.() ?? Date.now()) + (deps.idempotencyTtlMs ?? 300_000),
        settled: false,
      }
      : undefined;
    if (idempotencyKey !== undefined && entry) {
      idempotency.set(idempotencyKey, entry);
      void allocationResult.then(
        (result) => {
          entry.settled = true;
          if (result.status !== 200 && result.status !== 202) {
            if (idempotency.get(idempotencyKey) === entry) {
              idempotency.delete(idempotencyKey);
            }
          }
        },
        () => {
          entry.settled = true;
          if (idempotency.get(idempotencyKey) === entry) {
            idempotency.delete(idempotencyKey);
          }
        },
      );
    }
    const result = await allocationResult;
    return c.json(result.body, result.status);
  });

  app.get("/v1/allocations/:id", (c) => {
    const allocation = deps.control.getAllocation(c.req.param("id"));
    if (!allocation) {
      const missing = deps.control.allocationLookupError(c.req.param("id"));
      return c.json(missing.body, missing.status);
    }
    return c.json(publicAllocation(allocation));
  });

  app.post("/v1/allocations/:id/renew", async (c) => {
    const parsed = allocationRenewRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation renewal"), 400);
    }
    const result = deps.control.renewAllocation(c.req.param("id"), parsed.data.ttlSeconds);
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409 | 503);
  });

  app.post("/v1/allocations/:id/resolve", async (c) => {
    const parsed = allocationResolveRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = deps.control.resolveAllocation(c.req.param("id"), parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 409 | 503);
  });

  app.delete("/v1/allocations/:id", async (c) => {
    const result = await deps.control.releaseAllocation(c.req.param("id"));
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409);
  });

  app.post("/v1/chat/completions", (c) => handleGateway(c, {
    protocol: "openai.chat-completions.v1",
    upstreamPath: "/v1/chat/completions",
    bodyMode: "buffered",
    maxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
  }));

  app.post("/v1/audio/transcriptions", (c) => handleGateway(c, {
    protocol: "openai.audio-transcriptions.v1",
    upstreamPath: "/v1/audio/transcriptions",
    bodyMode: "stream",
    maxBodyBytes: deps.speechMaxBodyBytes ?? 257 * 1024 * 1024,
  }));

  app.post("/v1/audio/speech", (c) => handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/speech",
    bodyMode: "buffered",
    maxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
  }));

  app.get("/v1/audio/voices", (c) => handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/voices",
    bodyMode: "none",
    maxBodyBytes: 0,
  }));

  app.get("/v1/artifact-operations/:id", (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    const operation = deps.artifactManager.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "artifact operation not found"), 404);
    }
    return c.json(operation);
  });

  app.post("/v1/artifacts/:id/stage", async (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    return c.json(await deps.artifactManager.stage(c.req.param("id")), 202);
  });

  app.post("/v1/deployments/:runtime/activate", async (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    return c.json(await deps.artifactManager.activateRuntime(c.req.param("runtime")), 202);
  });

  app.post("/v1/deployments/:runtime/rollback", async (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    return c.json(await deps.artifactManager.rollbackRuntime(c.req.param("runtime")), 202);
  });

  app.post("/prepare", async (c) => {
    const parsed = prepareRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "profile or capabilities is required"), 400);
    }
    const result = await deps.control.prepare(parsed.data);
    return c.json(result.body, result.status as 200 | 202 | 400 | 404 | 409 | 503);
  });

  app.post("/release", async (c) => {
    const parsed = releaseRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "leaseId is required"), 400);
    }
    const result = await deps.control.release(parsed.data.leaseId);
    return c.json(result.body, result.status as 200 | 404);
  });

  app.post("/resolve", async (c) => {
    const parsed = resolveRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = deps.control.resolve(parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 503);
  });

  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  return app;
}
