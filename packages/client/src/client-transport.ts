import { errorResponseSchema } from "@larm/core";
import { LarmApiError } from "./errors";

export type ClientFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function sendClientRequest(options: {
  baseUrl: string;
  fetch: ClientFetch;
  apiToken?: string;
  managementToken?: string;
  path: string;
  init: RequestInit;
  management: boolean;
  timeoutMs: number;
  acceptedStatuses: readonly number[];
  sendApiToken: boolean;
  observeIdentity: (response: Response) => void;
}): Promise<Response> {
  const headers = new Headers(options.init.headers);
  if (options.sendApiToken && options.apiToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${options.apiToken}`);
  }
  if (options.management) {
    if (!options.managementToken) {
      throw new Error("LARM management token is required for this request");
    }
    headers.set("x-larm-management-token", options.managementToken);
  }
  const abort = new AbortController();
  const upstreamSignal = options.init.signal;
  const onAbort = () => abort.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    onAbort();
  } else {
    upstreamSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(
    () => abort.abort(new Error("LARM client timeout")),
    Math.max(0, options.timeoutMs),
  );
  timeout.unref?.();
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl}${options.path}`, {
      ...options.init,
      headers,
      signal: abort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
    throw error;
  }
  try {
    options.observeIdentity(response);
  } catch (error) {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!response.ok && !options.acceptedStatuses.includes(response.status)) {
    const body = await response.clone().json().catch(() => undefined);
    await response.body?.cancel().catch(() => undefined);
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
    const parsed = errorResponseSchema.safeParse(body);
    throw new LarmApiError(
      response.status,
      parsed.success ? parsed.data.error.code : "http_error",
      parsed.success ? parsed.data.error.message : `LARM returned HTTP ${response.status}`,
      body,
    );
  }
  if (!response.body) {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
    return response;
  }
  const reader = response.body.getReader();
  let cleaned = false;
  let managedController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let onManagedAbort: () => void = () => undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", onAbort);
    abort.signal.removeEventListener("abort", onManagedAbort);
  };
  onManagedAbort = () => {
    const reason = abort.signal.reason ?? new Error("LARM request aborted");
    void reader.cancel(reason).catch(() => undefined);
    cleanup();
    managedController?.error(reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      managedController = controller;
      abort.signal.addEventListener("abort", onManagedAbort, { once: true });
      if (abort.signal.aborted) onManagedAbort();
    },
    pull: async (controller) => {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          cleanup();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      abort.abort(reason);
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
