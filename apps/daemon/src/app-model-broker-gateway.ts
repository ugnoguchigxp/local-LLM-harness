import {
  chatCompletionRequestSchema,
  getRuntime,
  type Registry,
  type RuntimeProtocol,
} from "@larm/core";
import type { Context } from "hono";
import { openAiErrorBody } from "./app-http";
import type { DaemonIdentity } from "./identity";
import { ExecutionGate } from "./execution-gate";
import { ModelBroker, ModelBrokerError } from "./model-broker";
import { proxyGateway } from "./gateway";
import type { InferenceAuditRecorder } from "./inference-audit";
import type { ControlPlane } from "./controller";
import type { MetricsRegistry, RequestTracker } from "./metrics";

export type ModelBrokerGatewayRoute = {
  protocol: RuntimeProtocol;
  upstreamPath: string;
  bodyMode: "buffered" | "stream" | "none";
  maxBodyBytes: number;
  capability?: string;
};

export async function handleModelBrokerGateway(input: {
  context: Context;
  route: ModelBrokerGatewayRoute;
  broker?: ModelBroker;
  registry: Registry;
  control: ControlPlane;
  identity: DaemonIdentity;
  executionGate: ExecutionGate;
  gatewayTimeoutMs?: number;
  gatewayFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  getConfigRevision?: () => string;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: { name: string; labels?: Record<string, string>; value?: number }) => void;
  inferenceAuditMode?: "off" | "metadata" | "full-required";
  inferenceAuditRecorder?: InferenceAuditRecorder;
  exclusiveExecution: boolean;
  scopedProvider: boolean;
  declaredAllocationId?: string;
  directModel?: string;
  directRequestBytes?: Uint8Array;
  chatRequest?: unknown;
  chatResponseFormat?: "sse";
  expectedSpeechFormat?: string;
}): Promise<Response | undefined> {
  const { context: c, route: options, broker } = input;
  if (input.scopedProvider || input.declaredAllocationId !== undefined || !broker) return undefined;

  let directModel = input.directModel;
  let directRequestBytes = input.directRequestBytes;
  if (options.protocol === "openai.chat-completions.v1") {
    const parsed = chatCompletionRequestSchema.safeParse(input.chatRequest);
    if (!parsed.success) {
      return c.json(openAiErrorBody(
        "invalid_request",
        "model and messages are required",
        parsed.error.issues.some((issue) => issue.path[0] === "model") ? "model" : null,
      ), 400);
    }
    directModel = parsed.data.model;
  }
  if (!directModel || (options.bodyMode !== "none" && !directRequestBytes)) {
    return c.json(openAiErrorBody(
      "invalid_request",
      "a model is required for this endpoint",
      "model",
    ), 400);
  }

  let lease;
  try {
    lease = await broker.acquire(directModel, options.protocol, c.req.raw.signal);
  } catch (error) {
    if (error instanceof ModelBrokerError) {
      if (error.retryAfterSeconds) c.header("retry-after", String(error.retryAfterSeconds));
      return c.json(openAiErrorBody(
        error.code,
        error.message,
        error.code === "model_not_found" ? "model" : null,
      ), error.status);
    }
    throw error;
  }
  const runtime = getRuntime(input.registry, lease.runtime);
  if (!runtime || runtime.protocol !== options.protocol) {
    await lease.close();
    return c.json(openAiErrorBody(
      "model_unavailable",
      "resolved model runtime does not support Chat Completions",
      "model",
    ), 503);
  }
  try {
    return await proxyGateway({
      request: c.req.raw,
      ...(directRequestBytes ? { requestBody: directRequestBytes } : {}),
      allocationId: lease.allocationId,
      protocol: options.protocol,
      upstreamPath: options.bodyMode === "none"
        ? `${options.upstreamPath}${new URL(c.req.url).search}`
        : options.upstreamPath,
      runtime,
      bodyMode: options.bodyMode === "none" ? "none" : "buffered",
      maxBodyBytes: options.maxBodyBytes,
      timeoutMs: input.gatewayTimeoutMs ?? 300_000,
      bootEpoch: input.identity.bootEpoch,
      executionGate: input.executionGate,
      fetchImpl: input.gatewayFetch,
      metrics: input.metrics,
      requestTracker: input.requestTracker,
      lifecycleSignal: lease.lifecycleSignal,
      priority: lease.priority,
      exclusiveExecution: input.exclusiveExecution,
      now: input.now,
      random: input.random,
      onEvent: input.onEvent,
      inferenceAuditMode: input.inferenceAuditMode,
      inferenceAuditRecorder: input.inferenceAuditRecorder,
      auditContext: {
        capability: lease.capability,
        route: lease.route,
        ...(lease.release ? { runtimeRelease: lease.release } : {}),
        configRevision: lease.catalogRevision
          ?? input.getConfigRevision?.()
          ?? input.identity.configRevision,
      },
      responseFormat: input.chatResponseFormat,
      validateChatResponse: options.protocol === "openai.chat-completions.v1",
      validateTranscriptionResponse: options.protocol === "openai.audio-transcriptions.v1",
      validateSpeechResponse: options.protocol === "openai.audio-speech.v1"
        && options.bodyMode !== "none",
      validateVoiceCatalogResponse: options.protocol === "openai.audio-speech.v1"
        && options.bodyMode === "none",
      expectedSpeechFormat: input.expectedSpeechFormat,
      expectedModel: directModel,
      errorFormat: "openai",
      onFinish: () => lease.close(),
      revalidate: () => {
        const current = input.control.resolveAllocation(lease.allocationId, lease.capability);
        if (current.status !== 200 || !("endpoint" in current.body)) {
          return {
            ok: false,
            status: current.status,
            body: openAiErrorBody("model_unavailable", "model binding is no longer ready", "model"),
          };
        }
        if (current.body.runtime !== lease.runtime || current.body.endpoint !== lease.endpoint) {
          return {
            ok: false,
            status: 409,
            body: openAiErrorBody("model_binding_changed", "model binding changed", "model"),
          };
        }
        return { ok: true, binding: current.body };
      },
    });
  } catch (error) {
    await lease.close();
    throw error;
  }
}
