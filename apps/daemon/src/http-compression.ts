import type { MiddlewareHandler } from "hono";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";
import { constants, createGzip } from "node:zlib";
import { RequestBodyError, validateContentLength, withAbort } from "./http-body";

const MIN_BYTES = 1024;

/** Compression is a consumer-facing transport feature, not runtime identity. */
export function isMediaCompressionPath(path: string): boolean {
  return /^\/v1\/(?:embed|chat\/completions(?:\/input-tokens)?|audio\/(?:speech|transcriptions|voices)|music(?:\/.*)?|images\/generations|image-artifacts(?:\/.*)?)$/.test(path);
}

function acceptedEncodings(value: string | null): { gzip: boolean; identity: boolean } {
  if (!value) return { gzip: false, identity: true };
  const codings = new Map<string, number>();
  for (const part of value.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const raw = quality?.trim().slice(2);
    const q = raw === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    if (name) codings.set(name, q);
  }
  const gzip = codings.get("gzip") ?? codings.get("*") ?? 0;
  const identity = codings.get("identity") ?? (codings.get("*") === 0 ? 0 : 1);
  return {
    gzip: gzip > 0 && (!codings.has("identity") || gzip >= identity),
    identity: identity > 0,
  };
}

function varyEncoding(headers: Headers): void {
  const vary = headers.get("vary");
  if (vary !== "*" && !vary?.split(",").some((value) => value.trim().toLowerCase() === "accept-encoding")) {
    headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
}

function compressible(type: string): boolean {
  return type.startsWith("text/") || type === "application/json" || /\+(?:json|xml)$/.test(type)
    || type === "application/xml" || ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave", "audio/pcm"].includes(type);
}

function gzipBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const source = Readable.fromWeb(body);
  // Keep one dictionary for the response, flushing each input chunk so an SSE
  // delta or playable audio never waits for the end of inference.
  const gzip = createGzip({ level: 1, flush: constants.Z_SYNC_FLUSH });
  const output = Readable.toWeb(gzip, {
    strategy: { highWaterMark: 16 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as ReadableStream<Uint8Array>;
  // pipeline propagates downstream cancellation and errors back to inference.
  void pipeline(source, gzip, { signal }).catch(() => undefined);
  return output;
}

/** Inspect only a bounded prefix of finite JSON/text, never SSE or audio. */
async function responsePrefix(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; small: boolean }> {
  const reader = body.getReader();
  const prefix: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (bytes < MIN_BYTES) {
      const next = await withAbort(reader.read(), signal);
      if (next.done) { done = true; break; }
      prefix.push(next.value);
      bytes += next.value.byteLength;
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined).finally(() => reader.releaseLock());
    throw error;
  }
  return {
    small: done && bytes < MIN_BYTES,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (prefix.length) { controller.enqueue(prefix.shift()!); return; }
        if (done) { reader.releaseLock(); controller.close(); return; }
        try {
          const next = await reader.read();
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { reader.releaseLock(); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => undefined); reader.releaseLock(); },
    }),
  };
}

export async function compressMediaResponse(request: Request, response: Response): Promise<Response> {
  if (!isMediaCompressionPath(new URL(request.url).pathname) || !response.body
    || request.method === "HEAD" || response.status === 204 || response.status === 304
    || response.headers.has("content-encoding")) return response;
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const accepted = acceptedEncodings(request.headers.get("accept-encoding"));
  const canCompress = compressible(type) && response.status !== 206 && !request.headers.has("range")
    && !response.headers.has("content-range")
    && !/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "");
  if (!accepted.identity && (!accepted.gzip || !canCompress)) {
    void response.body.cancel(new Error("no acceptable response encoding")).catch(() => undefined);
    const headers = new Headers(response.headers);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) headers.delete(name);
    varyEncoding(headers);
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 406, headers });
  }
  if (!canCompress) return response;
  const headers = new Headers(response.headers);
  varyEncoding(headers);
  const sse = type === "text/event-stream";
  // Downstream intermediaries must not buffer/recompress the resulting SSE.
  if (sse) {
    headers.set("cache-control", `${headers.get("cache-control") ?? "no-cache"}, no-transform`);
    headers.set("x-accel-buffering", "no");
  }
  let body = response.body;
  const length = headers.get("content-length");
  if (accepted.gzip && (!accepted.identity || !length || Number(length) >= MIN_BYTES)) {
    let small = false;
    if (accepted.identity && !sse && !type.startsWith("audio/") && !length) ({ body, small } = await responsePrefix(body, request.signal));
    if (!small) {
      body = gzipBody(body, request.signal);
      headers.delete("content-length");
      headers.delete("accept-ranges");
      headers.set("content-encoding", "gzip");
      const etag = headers.get("etag");
      if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
    }
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function boundedBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new RequestBodyError("body_too_large", `request exceeds ${maxBytes} bytes`, 413);
        controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => undefined); reader.releaseLock(); },
  });
}

/** Do not pull or initialize gzip until an authorized route reads its body. */
function gzipRequestBody(request: Request, maxBytes: number): ReadableStream<Uint8Array> {
  let reader: WebStreamReader<Uint8Array> | undefined;
  let finished = false;
  let bytes = 0;
  const cleanup = () => {
    finished = true;
    request.signal.removeEventListener("abort", onAbort);
  };
  const cancel = (reason: unknown) => {
    if (!reader) return request.body!.cancel(reason);
    const active = reader;
    return active.cancel(reason).finally(() => active.releaseLock());
  };
  let onAbort: () => void;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (finished) return;
        cleanup();
        controller.error(request.signal.reason);
        void cancel(request.signal.reason).catch(() => undefined);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        if (!reader) {
          const decoder = new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
          reader = boundedBody(request.body!, maxBytes).pipeThrough(decoder, { signal: request.signal }).getReader();
        }
        const next = await reader.read();
        if (finished) return;
        if (next.done) { cleanup(); reader.releaseLock(); controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new RequestBodyError("body_too_large", `request exceeds ${maxBytes} bytes`, 413);
        controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        cleanup();
        controller.error(error instanceof RequestBodyError ? error
          : new RequestBodyError("bad_request", "request body is not valid gzip", 400));
        void cancel(error).catch(() => undefined);
      }
    },
    cancel(reason) { cleanup(); return cancel(reason); },
  }, { highWaterMark: 0 });
}

export function mediaCompression(options: { gatewayMaxBodyBytes: number; speechMaxBodyBytes: number; embeddingMaxBodyBytes?: number }): MiddlewareHandler {
  return async (c, next) => {
    if (!isMediaCompressionPath(c.req.path)) { await next(); return; }
    const encoding = c.req.header("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      if (encoding !== "gzip") {
        c.header("accept-encoding", "gzip, identity");
        return c.json({ error: { code: "unsupported_content_encoding", message: "use gzip or identity", type: "invalid_request_error", param: null } }, 415);
      }
      const raw = c.req.raw;
      const maxBytes = c.req.path === "/v1/audio/transcriptions" ? options.speechMaxBodyBytes
        : c.req.path === "/v1/embed" ? options.embeddingMaxBodyBytes ?? 2 * 1024 * 1024
        : c.req.path === "/v1/image-artifacts/imports" ? 16 * 1024 ** 2 + 64 * 1024
        : c.req.path === "/v1/images/generations" ? 32 * 1024
        : options.gatewayMaxBodyBytes;
      validateContentLength(raw, maxBytes);
      if (!raw.body) throw new RequestBodyError("bad_request", "gzip request body is missing", 400);
      const decoded = gzipRequestBody(raw, maxBytes);
      const headers = new Headers(raw.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      // Install before observation/auth/usage middleware, preserving their
      // Request-keyed state and retaining the original abort signal.
      c.req.raw = new Request(raw, { body: decoded, headers, duplex: "half" });
    }
    try { await next(); }
    finally {
      if (encoding === "gzip" && c.res.status >= 400) {
        // A route can reject auth/model/readiness without reading its upload.
        // Dispose that lazy body so its source and abort listener do not linger.
        void c.req.raw.body?.cancel(new Error("request rejected")).catch(() => undefined);
      }
    }
    const original = c.res;
    const response = await compressMediaResponse(c.req.raw, original);
    if (response !== original) {
      // Hono merges the previous headers when replacing a response. Update
      // that set too, or it restores the plain Content-Length and validators.
      for (const name of [...original.headers.keys()]) {
        if (!response.headers.has(name)) original.headers.delete(name);
      }
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") original.headers.set(name, value);
      }
      c.res = response;
    }
  };
}
