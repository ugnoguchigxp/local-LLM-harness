import type { RuntimeDefinition, RuntimeProtocol } from "@larm/core";
import type { ControlEvent } from "./controller";
import {
  ExecutionGate,
  ExecutionGateError,
} from "./execution-gate";
import {
  limitedRequestStream,
  readBodyLimited,
  RequestBodyError,
  withAbort,
} from "./http-body";
import type { MetricsRegistry, RequestTracker } from "./metrics";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GatewayBinding = {
  endpoint: string;
  runtime: string;
};

type Revalidation =
  | { ok: true; binding: GatewayBinding }
  | { ok: false; status: number; body: unknown };

export type GatewayProxyOptions = {
  request: Request;
  allocationId: string;
  protocol: RuntimeProtocol;
  upstreamPath: string;
  runtime: RuntimeDefinition;
  bodyMode: "buffered" | "stream" | "none";
  maxBodyBytes: number;
  timeoutMs: number;
  bootEpoch: string;
  executionGate: ExecutionGate;
  revalidate: () => Revalidation;
  fetchImpl?: FetchLike;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  lifecycleSignal?: AbortSignal;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
};

const RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "retry-after",
  "x-voicevox-credit",
];

function jsonResponse(
  body: unknown,
  status: number,
  headers: ConstructorParameters<typeof Headers>[0] = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export async function proxyGateway(options: GatewayProxyOptions): Promise<Response> {
  const requestId = `req_${(options.random ?? (() => crypto.randomUUID()))()}`;
  const startedAt = options.now?.() ?? Date.now();
  const clientSignal = options.request.signal;
  const abort = new AbortController();
  let outcome = "pending";
  let timedOut = false;
  let bodyLimitError: RequestBodyError | undefined;
  let uploadError: unknown;
  let uploadCompletion = Promise.resolve();
  let releaseSlot: (() => void) | undefined;
  let finished = false;
  const finishTracked = options.requestTracker?.begin() ?? (() => undefined);
  const abortFromClient = () => {
    outcome = "client_cancelled";
    abort.abort(clientSignal.reason ?? new Error("client disconnected"));
  };
  const abortFromLifecycle = () => {
    outcome = "binding_invalidated";
    abort.abort(options.lifecycleSignal?.reason ?? new Error("allocation is no longer active"));
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    outcome = "timeout";
    abort.abort(new Error("gateway timeout"));
  }, options.timeoutMs);
  timeout.unref?.();

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timeout);
    clientSignal.removeEventListener("abort", abortFromClient);
    options.lifecycleSignal?.removeEventListener("abort", abortFromLifecycle);
    releaseSlot?.();
    finishTracked();
    options.metrics?.record({
      name: "gateway_duration_seconds",
      labels: { runtime: options.runtime.id, protocol: options.protocol },
      value: Math.max(0, ((options.now?.() ?? Date.now()) - startedAt) / 1_000),
    });
    options.onEvent?.({
      name: "gateway_request_completed",
      labels: {
        request: requestId,
        allocation: options.allocationId,
        runtime: options.runtime.id,
        protocol: options.protocol,
        outcome,
      },
    });
  };
  const failure = (
    code: string,
    message: string,
    status: number,
    result: string,
    headers?: ConstructorParameters<typeof Headers>[0],
  ) => {
    outcome = result;
    options.metrics?.record({
      name: "gateway_request",
      labels: { runtime: options.runtime.id, protocol: options.protocol, result },
    });
    finish();
    return jsonResponse({ error: { code, message } }, status, {
      "x-request-id": requestId,
      "x-larm-boot-epoch": options.bootEpoch,
      ...Object.fromEntries(new Headers(headers)),
    });
  };

  if (clientSignal.aborted) {
    abortFromClient();
  } else {
    clientSignal.addEventListener("abort", abortFromClient, { once: true });
  }
  if (options.lifecycleSignal?.aborted) {
    abortFromLifecycle();
  } else {
    options.lifecycleSignal?.addEventListener("abort", abortFromLifecycle, { once: true });
  }
  options.onEvent?.({
    name: "gateway_request_started",
    labels: {
      request: requestId,
      allocation: options.allocationId,
      runtime: options.runtime.id,
      protocol: options.protocol,
    },
  });

  try {
    releaseSlot = await options.executionGate.acquire(
      options.runtime.id,
      options.runtime.resources,
      abort.signal,
    );
  } catch (error) {
    if (timedOut) {
      return failure("gateway_timeout", "gateway request timed out", 504, "timeout");
    }
    if (clientSignal.aborted) {
      return failure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
    }
    if (options.lifecycleSignal?.aborted) {
      const invalidated = options.revalidate();
      if (!invalidated.ok) {
        outcome = "binding_invalidated";
        finish();
        return jsonResponse(invalidated.body, invalidated.status, {
          "x-request-id": requestId,
          "x-larm-boot-epoch": options.bootEpoch,
        });
      }
      return failure("allocation_inactive", "allocation is no longer active", 409, "binding_invalidated");
    }
    if (error instanceof ExecutionGateError) {
      const status = error.code === "draining" ? 503 : 429;
      const headers = error.retryAfterSeconds
        ? { "retry-after": String(error.retryAfterSeconds) }
        : undefined;
      return failure(error.code, error.message, status, error.code, headers);
    }
    return failure("execution_unavailable", "execution slot could not be acquired", 503, "gate_error");
  }

  const current = options.revalidate();
  if (!current.ok) {
    outcome = "binding_invalidated";
    finish();
    return jsonResponse(current.body, current.status, {
      "x-request-id": requestId,
      "x-larm-boot-epoch": options.bootEpoch,
    });
  }
  if (current.binding.runtime !== options.runtime.id) {
    return failure(
      "binding_changed",
      "allocation binding changed while waiting for execution",
      409,
      "binding_changed",
    );
  }

  let body: RequestInit["body"];
  try {
    if (options.bodyMode === "buffered") {
      body = await readBodyLimited(options.request, options.maxBodyBytes, abort.signal);
    } else if (options.bodyMode === "stream") {
      const limited = limitedRequestStream(
        options.request,
        options.maxBodyBytes,
        abort.signal,
        (error) => {
          bodyLimitError = error;
          abort.abort(error);
        },
      );
      body = limited.body;
      uploadCompletion = limited.completion;
      void uploadCompletion.catch(() => undefined);
    }
  } catch (error) {
    if (timedOut) {
      return failure("gateway_timeout", "gateway request timed out", 504, "timeout");
    }
    if (clientSignal.aborted) {
      return failure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
    }
    if (options.lifecycleSignal?.aborted) {
      return failure("allocation_inactive", "allocation is no longer active", 409, "binding_invalidated");
    }
    if (error instanceof RequestBodyError) {
      return failure(error.code, error.message, error.status, error.code);
    }
    return failure("bad_request", "request body could not be read", 400, "bad_request");
  }

  const headers = new Headers({
    accept: options.request.headers.get("accept") ?? "application/json",
    "content-type": options.request.headers.get("content-type") ?? "application/json",
    "x-request-id": requestId,
  });
  const endpoint = current.binding.endpoint.replace(/\/+$/, "");
  const target = `${endpoint}${options.upstreamPath}`;
  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: options.request.method,
      headers,
      body,
      signal: abort.signal,
    };
    if (options.bodyMode === "stream" && body) {
      init.duplex = "half";
    }
    const response = await withAbort((options.fetchImpl ?? fetch)(target, init), abort.signal);
    try {
      await withAbort(uploadCompletion, abort.signal);
    } catch (error) {
      uploadError = error;
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    upstream = response;
  } catch {
    if (bodyLimitError) {
      return failure(bodyLimitError.code, bodyLimitError.message, bodyLimitError.status, bodyLimitError.code);
    }
    if (timedOut) {
      return failure("gateway_timeout", "upstream request timed out", 504, "timeout");
    }
    if (clientSignal.aborted) {
      return failure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
    }
    if (options.lifecycleSignal?.aborted) {
      const invalidated = options.revalidate();
      if (!invalidated.ok) {
        outcome = "binding_invalidated";
        finish();
        return jsonResponse(invalidated.body, invalidated.status, {
          "x-request-id": requestId,
          "x-larm-boot-epoch": options.bootEpoch,
        });
      }
      return failure("allocation_inactive", "allocation is no longer active", 409, "binding_invalidated");
    }
    if (uploadError) {
      return failure(
        "request_upload_incomplete",
        "upstream did not consume the complete request body",
        502,
        "upload_incomplete",
      );
    }
    return failure("upstream_unavailable", "upstream request failed", 502, "upstream_error");
  }

  outcome = `http_${upstream.status}`;
  options.metrics?.record({
    name: "gateway_ttfb_seconds",
    labels: {
      runtime: options.runtime.id,
      protocol: options.protocol,
      status: String(upstream.status),
    },
    value: ((options.now?.() ?? Date.now()) - startedAt) / 1_000,
  });
  options.metrics?.record({
    name: "gateway_request",
    labels: {
      runtime: options.runtime.id,
      protocol: options.protocol,
      status: String(upstream.status),
    },
  });

  const responseHeaders = new Headers({
    "x-request-id": requestId,
    "x-larm-boot-epoch": options.bootEpoch,
  });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  }
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  if (!upstream.body) {
    finish();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
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
      } catch (error) {
        if (!timedOut && !clientSignal.aborted && !options.lifecycleSignal?.aborted) {
          outcome = "stream_error";
        }
        await reader.cancel(error).catch(() => undefined);
        finish();
        controller.error(error);
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
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}
