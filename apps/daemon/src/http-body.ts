export class RequestBodyError extends Error {
  constructor(
    readonly code: "bad_request" | "body_too_large",
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export function validateContentLength(request: Request, maxBytes: number): void {
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

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const rejectAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
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
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function readBodyLimited(
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
        throw new RequestBodyError("body_too_large", `request exceeds ${maxBytes} bytes`, 413);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original input or abort error.
    }
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function limitedRequestStream(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
  onLimit: (error: RequestBodyError) => void,
): { body: ReadableStream<Uint8Array> | undefined; completion: Promise<void> } {
  validateContentLength(request, maxBytes);
  if (!request.body) {
    return { body: undefined, completion: Promise.resolve() };
  }
  const reader = request.body.getReader();
  let total = 0;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const complete = () => {
    if (!settled) {
      settled = true;
      resolveCompletion();
    }
  };
  const fail = (error: unknown) => {
    if (!settled) {
      settled = true;
      rejectCompletion(error);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await withAbort(reader.read(), signal);
        if (chunk.done) {
          complete();
          controller.close();
          return;
        }
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          const error = new RequestBodyError(
            "body_too_large",
            `request exceeds ${maxBytes} bytes`,
            413,
          );
          onLimit(error);
          fail(error);
          await reader.cancel(error).catch(() => undefined);
          controller.error(error);
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        fail(error);
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      fail(reason instanceof Error ? reason : new Error("request upload was cancelled"));
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { body, completion };
}
