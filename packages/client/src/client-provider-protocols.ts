import {
  embeddingAgentProviderDescriptorSchema,
  embeddingRequestSchema,
  errorResponseSchema,
  inspectEmbeddingResponse,
  inspectSystemOneResponse,
  systemOneAgentProviderDescriptorSchema,
  systemOneRequestSchema,
  visualPerceptionAgentProviderDescriptorSchema,
  visualPerceptionRequestSchema,
  inspectVisualPerceptionResponse,
  type VisualPerceptionRequest,
  type VisualPerceptionResponse,
  type AgentConnectionClaim,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type SystemOneRequest,
  type SystemOneResponse,
} from "@larm/core";
import { LarmApiError } from "./errors";
import { compressClientRequest } from "./client-compression";

export type EmbeddingAgentProvider = Extract<
  AgentConnectionClaim["providers"][number],
  { apiStyle: "larm-embedding" }
>;
export type SystemOneAgentProvider = Extract<
  AgentConnectionClaim["providers"][number],
  { apiStyle: "larm-system-one" }
>;

export type VisualPerceptionAgentProvider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "larm-visual-perception" }>;

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function embedWithClaimedProvider(input: {
  fetch: ProviderFetch;
  timeoutMs: number;
  requestCompression?: "gzip" | false;
  claimedProvider: EmbeddingAgentProvider;
  requestInput: EmbeddingRequest;
  signal?: AbortSignal;
}): Promise<EmbeddingResponse> {
  const provider = embeddingAgentProviderDescriptorSchema.parse(input.claimedProvider);
  const request = embeddingRequestSchema.parse(input.requestInput);
  const abort = new AbortController();
  const onAbort = () => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => abort.abort(new Error("LARM embedding client timeout")),
    input.timeoutMs,
  );
  timeout.unref?.();
  try {
    let init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.credential.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(request),
      redirect: "manual",
      signal: abort.signal,
    };
    if (input.requestCompression !== false) {
      init = await compressClientRequest(new URL(provider.endpoint).pathname, init);
    }
    abort.signal.throwIfAborted();
    const response = await input.fetch(provider.endpoint, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(new Error("provider redirect is forbidden")).catch(() => undefined);
      throw new LarmApiError(502, "provider_redirect_forbidden", "embedding provider returned a redirect");
    }
    const bytes = await readResponseLimited(response, 2 * 1024 * 1024);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new LarmApiError(502, "embedding_response_invalid", "embedding provider returned invalid JSON");
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(value);
      throw new LarmApiError(
        response.status,
        parsed.success ? parsed.data.error.code : "embedding_http_error",
        parsed.success ? parsed.data.error.message : `embedding provider returned HTTP ${response.status}`,
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new LarmApiError(502, "embedding_response_invalid", "embedding provider did not return JSON");
    }
    const inspected = inspectEmbeddingResponse({ value, request, space: provider.embeddingSpace });
    if (!inspected.ok) {
      throw new LarmApiError(
        502,
        `embedding_${inspected.reason}`,
        "embedding provider response does not match the claimed semantic space",
      );
    }
    return inspected.response;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function systemOneWithClaimedProvider(input: {
  fetch: ProviderFetch;
  claimedProvider: SystemOneAgentProvider;
  requestInput: SystemOneRequest;
  signal?: AbortSignal;
}): Promise<SystemOneResponse> {
  const provider = systemOneAgentProviderDescriptorSchema.parse(input.claimedProvider);
  const request = systemOneRequestSchema.parse(input.requestInput);
  const response = await input.fetch(provider.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.credential.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(request),
    redirect: "manual",
    signal: input.signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel(new Error("provider redirect is forbidden")).catch(() => undefined);
    throw new LarmApiError(502, "provider_redirect_forbidden", "System One provider returned a redirect");
  }
  const bytes = await readResponseLimited(response, 2 * 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new LarmApiError(502, "system_one_response_invalid", "System One provider returned invalid JSON");
  }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(value);
    throw new LarmApiError(
      response.status,
      parsed.success ? parsed.data.error.code : "system_one_http_error",
      parsed.success ? parsed.data.error.message : `System One provider returned HTTP ${response.status}`,
    );
  }
  const inspected = inspectSystemOneResponse({ value, request });
  if (!inspected.ok) {
    throw new LarmApiError(502, `system_one_${inspected.reason}`, "System One response does not match the request");
  }
  return inspected.response;
}

export async function perceiveWithClaimedProvider(input: {
  fetch: ProviderFetch; claimedProvider: VisualPerceptionAgentProvider;
  requestInput: VisualPerceptionRequest; signal?: AbortSignal;
}): Promise<VisualPerceptionResponse> {
  const provider = visualPerceptionAgentProviderDescriptorSchema.parse(input.claimedProvider);
  const request = visualPerceptionRequestSchema.parse(input.requestInput);
  if (request.model !== provider.model) throw new LarmApiError(400, "model_mismatch", "model must match the claimed provider");
  const deadline = AbortSignal.timeout(185_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const response = await input.fetch(provider.endpoint, {
    method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`,
      "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request), redirect: "manual", signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new LarmApiError(502, "provider_redirect_forbidden", "visual perception provider returned a redirect");
  }
  const bytes = await readResponseLimited(response, 8 * 1024 * 1024, "visual_perception");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new LarmApiError(502, "visual_perception_response_invalid", "invalid visual perception JSON"); }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(value);
    throw new LarmApiError(response.status, parsed.success ? parsed.data.error.code : "visual_perception_http_error",
      parsed.success ? parsed.data.error.message : "visual perception request failed");
  }
  const inspected = inspectVisualPerceptionResponse(value, request);
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !inspected.ok) {
    throw new LarmApiError(502, "visual_perception_response_invalid", "visual perception response does not match the request");
  }
  return inspected.response;
}

async function readResponseLimited(response: Response, maxBytes: number, errorPrefix = "embedding"): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel(new Error("provider response too large")).catch(() => undefined);
    throw new LarmApiError(502, `${errorPrefix}_response_too_large`, "provider response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new LarmApiError(502, `${errorPrefix}_response_too_large`, "provider response is too large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
