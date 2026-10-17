const MIN_REQUEST_BYTES = 4096;

function mediaPath(path: string): boolean {
  return /^\/v1\/(?:embed|chat\/completions(?:\/input-tokens)?|audio\/(?:speech|transcriptions)|music(?:\/.*)?|images\/generations)$/.test(path);
}

/** Response decoding remains the fetch implementation's responsibility. */
export async function compressClientRequest(path: string, init: RequestInit): Promise<RequestInit> {
  if (!mediaPath(path) || !init.body) return init;
  const headers = new Headers(init.headers);
  if (headers.has("content-encoding")) return init;
  let body: ReadableStream<Uint8Array>;
  if (typeof init.body === "string") {
    const bytes = new TextEncoder().encode(init.body);
    if (bytes.byteLength < MIN_REQUEST_BYTES) return init;
    body = new Blob([bytes]).stream();
  } else if (init.body instanceof FormData) {
    // Multipart remains multipart after decoding. Avoid gzipping already
    // compressed recordings; raw WAV uploads are the useful ASR case.
    const file = init.body.get("file");
    if (!(file instanceof Blob) || file.size < MIN_REQUEST_BYTES
      || !["audio/wav", "audio/wave", "audio/x-wav", "audio/pcm"].includes(file.type.toLowerCase())) return init;
    const serialized = new Request("http://larm.invalid", { method: "POST", headers, body: init.body });
    headers.set("content-type", serialized.headers.get("content-type")!);
    body = serialized.body!;
  } else {
    // Arbitrary streams are not buffered by the SDK. Callers can supply their
    // own gzip body and Content-Encoding when streaming an upload.
    return init;
  }
  init.signal?.throwIfAborted();
  let originalBytes = 0;
  const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      init.signal?.throwIfAborted();
      originalBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }), { signal: init.signal ?? undefined });
  const compressor = new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
  const compressed = await new Response(counted.pipeThrough(compressor, { signal: init.signal ?? undefined })).arrayBuffer();
  init.signal?.throwIfAborted();
  if (compressed.byteLength >= originalBytes) return init;
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  return { ...init, headers, body: compressed };
}
