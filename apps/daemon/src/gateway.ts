import {
  inspectEmbeddingResponse,
  inspectOpenAiChatCompletionJson,
  inspectOpenAiTranscriptionJson,
  isOpenAiSpeechMediaType,
  OpenAiChatCompletionSseInspector,
  OpenAiChatCompletionSseNormalizer,
  type RuntimeDefinition,
  type RuntimeProtocol,
  type EmbeddingRequest,
  type EmbeddingSpace,
} from "@larm/core";
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
import type {
  InferenceAuditCaptureSession,
  InferenceAuditRecorder,
} from "./inference-audit";

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
  requestBody?: Uint8Array;
  maxBodyBytes: number;
  timeoutMs: number;
  bootEpoch: string;
  executionGate: ExecutionGate;
  revalidate: () => Revalidation;
  fetchImpl?: FetchLike;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  lifecycleSignal?: AbortSignal;
  priority?: number;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
  inferenceAuditMode?: "off" | "metadata" | "full-required";
  inferenceAuditRecorder?: InferenceAuditRecorder;
  auditContext?: {
    capability: string;
    route: string;
    runtimeRelease?: string;
    configRevision: string;
  };
  responseFormat?: "sse";
  validateChatResponse?: boolean;
  validateTranscriptionResponse?: boolean;
  validateSpeechResponse?: boolean;
  validateEmbeddingResponse?: {
    request: EmbeddingRequest;
    space: EmbeddingSpace;
  };
  expectedSpeechFormat?: string;
  expectedModel?: string;
  maxResponseBytes?: number;
  errorFormat?: "larm" | "openai";
  onFinish?: () => void | Promise<void>;
};

const RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "retry-after",
  "x-audio-sample-format",
  "x-audio-sample-rate",
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
  let cancelUpstream: ((reason: unknown) => Promise<void>) | undefined;
  let upstreamStatus: number | undefined;
  let auditSession: InferenceAuditCaptureSession | undefined;
  let auditFinalization: Promise<void> | undefined;
  let auditResponseCaptureFailed = false;
  let auditMetadataStarted = false;
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
  let timeout: ReturnType<typeof setTimeout>;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timeout);
    clientSignal.removeEventListener("abort", abortFromClient);
    options.lifecycleSignal?.removeEventListener("abort", abortFromLifecycle);
    releaseSlot?.();
    try {
      void Promise.resolve(options.onFinish?.()).catch(() => {
        options.onEvent?.({
          name: "gateway_finish_callback_failed",
          labels: { request: requestId },
        });
      });
    } catch {
      options.onEvent?.({
        name: "gateway_finish_callback_failed",
        labels: { request: requestId },
      });
    }
    finishTracked();
    options.metrics?.record({
      name: "gateway_duration_seconds",
      labels: { runtime: options.runtime.id, protocol: options.protocol },
      value: Math.max(0, ((options.now?.() ?? Date.now()) - startedAt) / 1_000),
    });
    if (auditMetadataStarted) {
      options.onEvent?.({
        name: "inference_audit_completed",
        labels: { request: requestId, outcome },
      });
    }
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
  const finalizeAudit = (): Promise<void> => {
    if (auditFinalization) return auditFinalization;
    if (!auditSession) return Promise.resolve();
    const finalOutcome = outcome;
    const finalUpstreamStatus = upstreamStatus;
    auditFinalization = auditSession.finalize({
      outcome: finalOutcome,
      upstreamStatus: finalUpstreamStatus,
    }).then(() => {
      options.onEvent?.({
        name: "inference_audit_completed",
        labels: { request: requestId, outcome: finalOutcome },
      });
    }).catch(() => {
      options.onEvent?.({
        name: "inference_audit_capture_failed",
        labels: { request: requestId, phase: "finalize" },
      });
    });
    return auditFinalization;
  };
  timeout = setTimeout(() => {
    timedOut = true;
    outcome = "timeout";
    const reason = new Error("gateway timeout");
    abort.abort(reason);
    void cancelUpstream?.(reason).catch(() => undefined);
    void finalizeAudit().finally(finish);
  }, options.timeoutMs);
  timeout.unref?.();
  const failure = async (
    code: string,
    message: string,
    status: number,
    result: string,
    headers?: ConstructorParameters<typeof Headers>[0],
  ): Promise<Response> => {
    outcome = result;
    options.metrics?.record({
      name: "gateway_request",
      labels: { runtime: options.runtime.id, protocol: options.protocol, result },
    });
    await finalizeAudit();
    finish();
    const body = options.errorFormat === "openai"
      ? {
        error: {
          message,
          type: status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error",
          param: null,
          code,
        },
      }
      : { error: { code, message } };
    return jsonResponse(body, status, {
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
      options.priority ?? 0,
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
    if (options.requestBody) {
      if (options.bodyMode !== "buffered") {
        throw new Error("a prepared request body requires buffered body mode");
      }
      body = options.requestBody;
    } else if (options.bodyMode === "buffered") {
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

  if (
    options.protocol === "openai.chat-completions.v1"
    && options.inferenceAuditMode === "metadata"
  ) {
    auditMetadataStarted = true;
    options.onEvent?.({
      name: "inference_audit_started",
      labels: { request: requestId, mode: "metadata" },
    });
  }

  if (
    options.protocol === "openai.chat-completions.v1"
    && options.inferenceAuditMode === "full-required"
  ) {
    if (!options.inferenceAuditRecorder || !options.auditContext || !(body instanceof Uint8Array)) {
      options.onEvent?.({
        name: "inference_audit_capture_failed",
        labels: { request: requestId, phase: "begin" },
      });
      return failure(
        "inference_audit_unavailable",
        "required inference audit storage is unavailable",
        503,
        "audit_unavailable",
      );
    }
    try {
      auditSession = await options.inferenceAuditRecorder.begin({
        requestId,
        allocationId: options.allocationId,
        capability: options.auditContext.capability,
        route: options.auditContext.route,
        runtime: options.runtime.id,
        ...(options.auditContext.runtimeRelease
          ? { runtimeRelease: options.auditContext.runtimeRelease }
          : {}),
        bootEpoch: options.bootEpoch,
        configRevision: options.auditContext.configRevision,
        endpoint: current.binding.endpoint,
        requestBody: body,
        signal: abort.signal,
      });
      options.onEvent?.({
        name: "inference_audit_started",
        labels: { request: requestId },
      });
    } catch {
      options.onEvent?.({
        name: "inference_audit_capture_failed",
        labels: { request: requestId, phase: "begin" },
      });
      if (timedOut) {
        return failure("gateway_timeout", "gateway request timed out", 504, "timeout");
      }
      if (clientSignal.aborted) {
        return failure("request_cancelled", "client cancelled the request", 400, "client_cancelled");
      }
      if (options.lifecycleSignal?.aborted) {
        return failure(
          "allocation_inactive",
          "allocation is no longer active",
          409,
          "binding_invalidated",
        );
      }
      return failure(
        "inference_audit_unavailable",
        "required inference audit storage is unavailable",
        503,
        "audit_unavailable",
      );
    }
  }

  const headers = new Headers({
    accept: options.responseFormat === "sse"
      ? "text/event-stream"
      : options.request.headers.get("accept") ?? "application/json",
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
      redirect: "manual",
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
        await finalizeAudit();
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

  upstreamStatus = upstream.status;
  options.metrics?.record({
    name: "gateway_ttfb_seconds",
    labels: {
      runtime: options.runtime.id,
      protocol: options.protocol,
      status: String(upstream.status),
    },
    value: ((options.now?.() ?? Date.now()) - startedAt) / 1_000,
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel(new Error("upstream redirect is forbidden")).catch(() => undefined);
    return failure(
      "upstream_redirect_forbidden",
      "upstream redirects are not allowed",
      502,
      "upstream_protocol_error",
    );
  }
  if (
    options.responseFormat === "sse"
    && upstream.ok
    && upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      !== "text/event-stream"
  ) {
    await upstream.body?.cancel(new Error("upstream did not return an SSE response")).catch(() => undefined);
    return failure(
      "upstream_response_format_mismatch",
      "upstream did not return text/event-stream for a streaming chat request",
      502,
      "upstream_protocol_error",
    );
  }
  if (
    options.validateSpeechResponse
    && options.protocol === "openai.audio-speech.v1"
    && upstream.ok
    && !isOpenAiSpeechMediaType(
      upstream.headers.get("content-type") ?? "",
      options.expectedSpeechFormat,
    )
  ) {
    await upstream.body?.cancel(new Error("upstream returned the wrong audio format")).catch(() => undefined);
    return failure(
      "upstream_response_format_mismatch",
      "upstream speech response media type does not match response_format",
      502,
      "upstream_protocol_error",
    );
  }
  outcome = `http_${upstream.status}`;
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
  if (options.responseFormat === "sse" && upstream.ok) {
    responseHeaders.set("cache-control", "no-cache, no-transform");
    responseHeaders.set("x-accel-buffering", "no");
  }
  if (
    options.validateEmbeddingResponse
    && options.protocol === "larm.embedding.v1"
    && upstream.ok
  ) {
    if (
      upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      !== "application/json"
    ) {
      await upstream.body?.cancel(new Error("upstream did not return JSON")).catch(() => undefined);
      return failure(
        "upstream_response_format_mismatch",
        "upstream did not return application/json for an embedding request",
        502,
        "upstream_protocol_error",
      );
    }
    let responseBody: Uint8Array;
    let parsed: unknown;
    try {
      responseBody = await readBodyLimited(
        upstream as unknown as Request,
        options.maxResponseBytes ?? 2 * 1024 * 1024,
        abort.signal,
      );
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody)) as unknown;
    } catch {
      return failure(
        "upstream_response_invalid",
        "upstream returned an invalid or oversized embedding response",
        502,
        "upstream_protocol_error",
      );
    }
    const inspected = inspectEmbeddingResponse({
      value: parsed,
      request: options.validateEmbeddingResponse.request,
      space: options.validateEmbeddingResponse.space,
    });
    if (!inspected.ok) {
      return failure(
        "upstream_response_invalid",
        `upstream embedding response failed ${inspected.reason}`,
        502,
        "upstream_protocol_error",
      );
    }
    options.onEvent?.({
      name: "gateway_embedding_verified",
      labels: {
        request: requestId,
        runtime: options.runtime.id,
        modelRevision: options.validateEmbeddingResponse.space.model.revision,
        dimension: String(options.validateEmbeddingResponse.space.dimension),
        inputType: options.validateEmbeddingResponse.request.type,
      },
    });
    await finalizeAudit();
    finish();
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  }
  if (
    options.validateChatResponse
    && options.protocol === "openai.chat-completions.v1"
    && options.responseFormat !== "sse"
    && upstream.ok
  ) {
    if (
      upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      !== "application/json"
    ) {
      await upstream.body?.cancel(new Error("upstream did not return JSON")).catch(() => undefined);
      return failure(
        "upstream_response_format_mismatch",
        "upstream did not return application/json for a non-streaming chat request",
        502,
        "upstream_protocol_error",
      );
    }
    let responseBody: Uint8Array;
    let parsed: unknown;
    try {
      responseBody = await readBodyLimited(
        upstream as unknown as Request,
        options.maxResponseBytes ?? 16 * 1024 * 1024,
        abort.signal,
      );
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody)) as unknown;
    } catch {
      return failure(
        "upstream_response_invalid",
        "upstream returned an invalid or oversized chat completion",
        502,
        "upstream_protocol_error",
      );
    }
    const inspected = inspectOpenAiChatCompletionJson(parsed);
    if (!inspected.ok) {
      return failure(
        "upstream_response_invalid",
        "upstream returned a chat completion that does not match the public contract",
        502,
        "upstream_protocol_error",
      );
    }
    if (options.expectedModel !== undefined) {
      (parsed as Record<string, unknown>).model = options.expectedModel;
      responseBody = new TextEncoder().encode(JSON.stringify(parsed));
      responseHeaders.set("content-length", String(responseBody.byteLength));
    }
    if (auditSession && !auditResponseCaptureFailed) {
      try {
        auditSession.captureResponse(responseBody);
      } catch {
        auditResponseCaptureFailed = true;
        try {
          auditSession.markResponseCaptureFailed?.();
        } catch {
          // Finalization remains isolated; response validation must not expose audit failures.
        }
        options.onEvent?.({
          name: "inference_audit_capture_failed",
          labels: { request: requestId, phase: "response" },
        });
      }
    }
    options.onEvent?.({
      name: "gateway_json_terminal_verified",
      labels: { request: requestId, runtime: options.runtime.id },
    });
    await finalizeAudit();
    finish();
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  }
  if (
    options.validateTranscriptionResponse
    && options.protocol === "openai.audio-transcriptions.v1"
    && upstream.ok
  ) {
    if (
      upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      !== "application/json"
    ) {
      await upstream.body?.cancel(new Error("upstream did not return JSON")).catch(() => undefined);
      return failure(
        "upstream_response_format_mismatch",
        "upstream did not return application/json for a transcription request",
        502,
        "upstream_protocol_error",
      );
    }
    let responseBody: Uint8Array;
    let parsed: unknown;
    try {
      responseBody = await readBodyLimited(
        upstream as unknown as Request,
        options.maxResponseBytes ?? 4 * 1024 * 1024,
        abort.signal,
      );
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody)) as unknown;
    } catch {
      return failure(
        "upstream_response_invalid",
        "upstream returned an invalid or oversized transcription",
        502,
        "upstream_protocol_error",
      );
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const transcription = parsed as Record<string, unknown>;
      if (
        transcription.language === null
        || (typeof transcription.language === "string" && transcription.language.trim().length === 0)
      ) {
        delete transcription.language;
        responseBody = new TextEncoder().encode(JSON.stringify(transcription));
        responseHeaders.set("content-length", String(responseBody.byteLength));
      }
    }
    if (!inspectOpenAiTranscriptionJson(parsed).ok) {
      return failure(
        "upstream_response_invalid",
        "upstream transcription does not match the public contract",
        502,
        "upstream_protocol_error",
      );
    }
    options.onEvent?.({
      name: "gateway_json_terminal_verified",
      labels: { request: requestId, runtime: options.runtime.id },
    });
    await finalizeAudit();
    finish();
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  }
  if (!upstream.body) {
    await finalizeAudit();
    finish();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  const reader = upstream.body.getReader();
  const sseInspector = options.responseFormat === "sse" && upstream.ok
    ? new OpenAiChatCompletionSseInspector()
    : undefined;
  const sseNormalizer = sseInspector && options.expectedModel !== undefined
    ? new OpenAiChatCompletionSseNormalizer(options.expectedModel)
    : undefined;
  if (sseNormalizer) responseHeaders.delete("content-length");
  let firstMeaningfulOutputObserved = false;
  const failStreamProtocol = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: string,
  ): Promise<void> => {
    outcome = `stream_protocol_${reason}`;
    options.metrics?.record({
      name: "gateway_stream_protocol_error",
      labels: { runtime: options.runtime.id, reason },
    });
    options.onEvent?.({
      name: "gateway_stream_protocol_error",
      labels: { request: requestId, runtime: options.runtime.id, reason },
    });
    const error = new Error(`upstream SSE contract failed: ${reason}`);
    await reader.cancel(error).catch(() => undefined);
    await finalizeAudit();
    finish();
    controller.error(error);
  };
  const enqueueSseOutput = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    output: Uint8Array[],
  ): Promise<boolean> => {
    for (const bytes of output) {
      const progress = sseInspector?.push(bytes);
      if (progress && !progress.ok) {
        await failStreamProtocol(controller, progress.reason);
        return false;
      }
      if (progress?.ok && progress.deltas > 0 && !firstMeaningfulOutputObserved) {
        firstMeaningfulOutputObserved = true;
        const elapsed = Math.max(0, ((options.now?.() ?? Date.now()) - startedAt) / 1_000);
        options.metrics?.record({
          name: "gateway_first_meaningful_output_seconds",
          labels: { runtime: options.runtime.id, protocol: options.protocol },
          value: elapsed,
        });
        options.onEvent?.({
          name: "gateway_first_meaningful_output",
          labels: { request: requestId, runtime: options.runtime.id },
          value: elapsed,
        });
      }
      if (auditSession && !auditResponseCaptureFailed) {
        try {
          auditSession.captureResponse(bytes);
        } catch {
          auditResponseCaptureFailed = true;
          try {
            auditSession.markResponseCaptureFailed?.();
          } catch {
            // Finalization is already isolated; the client stream must continue.
          }
          options.onEvent?.({
            name: "inference_audit_capture_failed",
            labels: { request: requestId, phase: "response" },
          });
        }
      }
      controller.enqueue(bytes);
    }
    return true;
  };
  cancelUpstream = async (reason) => await reader.cancel(reason);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await withAbort(reader.read(), abort.signal);
        if (chunk.done) {
          if (sseNormalizer) {
            const normalized = sseNormalizer.finish();
            if (!normalized.ok) {
              await failStreamProtocol(controller, normalized.reason);
              return;
            }
            if (!await enqueueSseOutput(controller, normalized.output)) return;
          }
          const inspected = sseInspector?.finish();
          if (inspected && !inspected.ok) {
            await failStreamProtocol(controller, inspected.reason);
            return;
          }
          if (inspected?.ok) {
            if (options.expectedModel !== undefined && inspected.model !== options.expectedModel) {
              await failStreamProtocol(controller, "model_mismatch");
              return;
            }
            options.onEvent?.({
              name: "gateway_stream_terminal_verified",
              labels: { request: requestId, runtime: options.runtime.id },
            });
          }
          await finalizeAudit();
          finish();
          controller.close();
          return;
        }
        const normalized = sseNormalizer?.push(chunk.value);
        if (normalized && !normalized.ok) {
          await failStreamProtocol(controller, normalized.reason);
          return;
        }
        const output = normalized?.output ?? [chunk.value];
        if (!await enqueueSseOutput(controller, output)) return;
      } catch (error) {
        if (!timedOut && !clientSignal.aborted && !options.lifecycleSignal?.aborted) {
          outcome = "stream_error";
        }
        await reader.cancel(error).catch(() => undefined);
        await finalizeAudit();
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
        await finalizeAudit();
        finish();
      }
    },
  });
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}
