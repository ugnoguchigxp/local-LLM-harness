import type { ClusterState, Registry } from "@larm/core";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
  type Allocation,
} from "@larm/core";
import { Hono, type MiddlewareHandler } from "hono";
import type { ControlEvent, ControlPlane } from "./controller";
import type { ArtifactManager } from "./artifact-manager";
import type { MetricsRegistry, RequestTracker } from "./metrics";

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
  stateMaxAgeMs?: number;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
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

class RequestBodyError extends Error {
  constructor(
    readonly code: "bad_request" | "body_too_large",
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

function validateContentLength(request: Request, maxBytes: number): void {
  const header = request.headers.get("content-length");
  if (header === null) {
    return;
  }
  if (!/^\d+$/.test(header.trim())) {
    throw new RequestBodyError("bad_request", "invalid content-length header", 400);
  }
  if (Number(header) > maxBytes) {
    throw new RequestBodyError("body_too_large", `request exceeds ${maxBytes} bytes`, 413);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const rejectAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("request aborted"),
      );
    };
    const cleanup = () => signal.removeEventListener("abort", rejectAbort);
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

async function readBodyLimited(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  validateContentLength(request, maxBytes);
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = reader.read();
      const chunk = signal ? await withAbort(read, signal) : await read;
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new RequestBodyError(
          "body_too_large",
          `request exceeds ${maxBytes} bytes`,
          413,
        );
      }
      chunks.push(chunk.value);
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // Preserve the original input or abort error.
    }
    throw err;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestBodyError("bad_request", "request body must be valid JSON", 400);
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const controlMaxBodyBytes = deps.controlMaxBodyBytes ?? 64 * 1024;

  app.onError((err, c) => {
    if (err instanceof RequestBodyError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    console.error(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json(errorBody("internal_error", "internal server error"), 500);
  });

  app.use("*", async (c, next) => {
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

  app.get("/health", (c) => c.json({ status: "ok" }));

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
    const result = await deps.control.allocate(parsed.data);
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 202 | 400 | 403 | 404 | 409 | 503);
  });

  app.get("/v1/allocations/:id", (c) => {
    const allocation = deps.control.getAllocation(c.req.param("id"));
    if (!allocation) {
      return c.json(errorBody("not_found", "allocation not found"), 404);
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
    return c.json(body, result.status as 200 | 404 | 409);
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
    return c.json(body, result.status as 200 | 404);
  });

  app.post("/v1/chat/completions", async (c) => {
    if (deps.control.isDraining()) {
      return c.json(errorBody("draining", "control plane is draining"), 503);
    }
    const allocationId = c.req.header("x-larm-allocation-id");
    if (!allocationId) {
      return c.json(errorBody("allocation_required", "x-larm-allocation-id is required"), 400);
    }
    const binding = deps.control.resolveAllocation(allocationId, "llm.general");
    if (binding.status !== 200 || !("endpoint" in binding.body)) {
      return c.json(binding.body, binding.status as 404 | 409 | 503);
    }

    const requestId = `req_${(deps.random ?? (() => crypto.randomUUID()))()}`;
    const startedAt = deps.now?.() ?? Date.now();
    let outcome = "pending";
    deps.onEvent?.({
      name: "gateway_request_started",
      labels: {
        request: requestId,
        allocation: allocationId,
        runtime: binding.body.runtime,
      },
    });
    const finishTracked = deps.requestTracker?.begin() ?? (() => undefined);
    const abort = new AbortController();
    const clientSignal = c.req.raw.signal;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      clientSignal.removeEventListener("abort", abortFromClient);
      finishTracked();
      deps.metrics?.record({
        name: "gateway_duration_seconds",
        labels: { runtime: binding.body.runtime },
        value: Math.max(0, ((deps.now?.() ?? Date.now()) - startedAt) / 1_000),
      });
      deps.onEvent?.({
        name: "gateway_request_completed",
        labels: {
          request: requestId,
          allocation: allocationId,
          runtime: binding.body.runtime,
          outcome,
        },
      });
    };
    const abortFromClient = () => {
      outcome = "client_cancelled";
      abort.abort(clientSignal.reason);
      finish();
    };
    timeout = setTimeout(() => {
      timedOut = true;
      outcome = "timeout";
      abort.abort(new Error("gateway timeout"));
      finish();
    }, deps.gatewayTimeoutMs ?? 300_000);
    timeout.unref?.();
    if (clientSignal.aborted) {
      abortFromClient();
    } else {
      clientSignal.addEventListener("abort", abortFromClient, { once: true });
    }

    const gatewayFailure = (
      code: string,
      message: string,
      status: 400 | 413 | 502 | 504,
      result: string,
    ) => {
      outcome = result;
      deps.metrics?.record({ name: "gateway_request", labels: { result } });
      finish();
      return c.json(errorBody(code, message), status);
    };

    const maxBodyBytes = deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024;
    let body: Uint8Array;
    try {
      body = await readBodyLimited(c.req.raw, maxBodyBytes, abort.signal);
    } catch (err) {
      if (timedOut) {
        return gatewayFailure("gateway_timeout", "gateway request timed out", 504, "timeout");
      }
      if (clientSignal.aborted) {
        return gatewayFailure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
      }
      if (err instanceof RequestBodyError) {
        return gatewayFailure(err.code, err.message, err.status, err.code);
      }
      return gatewayFailure("bad_request", "request body could not be read", 400, "bad_request");
    }

    const endpoint = binding.body.endpoint.replace(/\/+$/, "");
    const target = `${endpoint}/v1/chat/completions`;
    let upstream: Response;
    try {
      const fetchRequest = (deps.gatewayFetch ?? fetch)(target, {
        method: "POST",
        headers: {
          "content-type": c.req.header("content-type") ?? "application/json",
          accept: c.req.header("accept") ?? "application/json",
          "x-request-id": requestId,
        },
        body,
        signal: abort.signal,
      });
      upstream = await withAbort(fetchRequest, abort.signal);
    } catch (err) {
      if (timedOut) {
        return gatewayFailure("gateway_timeout", "upstream request timed out", 504, "timeout");
      }
      if (clientSignal.aborted) {
        return gatewayFailure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
      }
      return gatewayFailure(
        "upstream_unavailable",
        "upstream request failed",
        502,
        "upstream_error",
      );
    }

    const ttfbSeconds = ((deps.now?.() ?? Date.now()) - startedAt) / 1000;
    outcome = `http_${upstream.status}`;
    deps.metrics?.record({
      name: "gateway_ttfb_seconds",
      labels: { runtime: binding.body.runtime, status: String(upstream.status) },
      value: ttfbSeconds,
    });
    deps.metrics?.record({
      name: "gateway_request",
      labels: { runtime: binding.body.runtime, status: String(upstream.status) },
    });

    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    headers.set("x-request-id", requestId);
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) {
      headers.set("cache-control", cacheControl);
    }
    if (!upstream.body) {
      finish();
      return new Response(null, { status: upstream.status, headers });
    }
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await withAbort(reader.read(), abort.signal);
          if (chunk.done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (err) {
          if (!timedOut && !clientSignal.aborted) {
            outcome = "stream_error";
          }
          void reader.cancel(err).catch(() => undefined);
          finish();
          controller.error(err);
        }
      },
      async cancel(reason) {
        outcome = "client_cancelled";
        abort.abort(reason);
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    return new Response(stream, { status: upstream.status, headers });
  });

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
