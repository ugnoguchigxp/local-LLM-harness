import {
  LocalInferenceAuditStore,
  type LocalInferenceAuditSession,
} from "@larm/backends";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { withAbort } from "./http-body";

export type InferenceAuditStart = {
  requestId: string;
  allocationId: string;
  capability: string;
  route: string;
  runtime: string;
  runtimeRelease?: string;
  bootEpoch: string;
  configRevision: string;
  endpoint: string;
  requestBody: Uint8Array;
  signal?: AbortSignal;
};

export type InferenceAuditFinish = {
  outcome: string;
  upstreamStatus?: number;
  interrupted?: boolean;
};

export interface InferenceAuditCaptureSession {
  captureResponse(chunk: Uint8Array): void;
  markResponseCaptureFailed?(): void;
  finalize(input: InferenceAuditFinish): Promise<void>;
}

export interface InferenceAuditRecorder {
  begin(input: InferenceAuditStart): Promise<InferenceAuditCaptureSession>;
}

export type FileInferenceAuditRecorderOptions = {
  store: LocalInferenceAuditStore;
  materializationTimeoutMs?: number;
  materializationMaxBytes?: number;
  fetchImpl?: typeof fetch;
};

export async function loadInferenceAuditKey(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let encoded: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 256) {
      throw new Error("inference audit key path must be a small regular file");
    }
    if ((metadata.mode & 0o037) !== 0) {
      throw new Error("inference audit key must not be writable by group or accessible by others");
    }
    if (
      typeof process.geteuid === "function"
      && metadata.uid !== 0
      && metadata.uid !== process.geteuid()
    ) {
      throw new Error("inference audit key must be owned by root or the daemon user");
    }
    const contents = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]{43}\n$/.test(contents)) {
      throw new Error("inference audit key must contain one canonical base64url line");
    }
    encoded = contents.slice(0, -1);
  } finally {
    await handle.close();
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error("inference audit key must be unpadded base64url for exactly 32 bytes");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    throw new Error("inference audit key must be unpadded base64url for exactly 32 bytes");
  }
  return decoded;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        throw new Error("provider materialization response exceeded its size limit");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function jsonResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`provider materialization returned HTTP ${response.status}`);
  }
  const bytes = await responseBytes(response, maximum, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("provider materialization returned invalid JSON");
  }
}

export class FileInferenceAuditRecorder implements InferenceAuditRecorder {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FileInferenceAuditRecorderOptions) {
    this.timeoutMs = options.materializationTimeoutMs ?? 30_000;
    this.maxBytes = options.materializationMaxBytes ?? 64 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("inference audit materialization timeout is invalid");
    }
    if (
      !Number.isSafeInteger(this.maxBytes)
      || this.maxBytes < 1
      || this.maxBytes > 64 * 1024 * 1024
    ) {
      throw new Error("inference audit materialization size limit is invalid");
    }
  }

  async begin(input: InferenceAuditStart): Promise<InferenceAuditCaptureSession> {
    const session = await this.options.store.begin({
      requestId: input.requestId,
      allocationId: input.allocationId,
      capability: input.capability,
      route: input.route,
      runtime: input.runtime,
      ...(input.runtimeRelease ? { runtimeRelease: input.runtimeRelease } : {}),
      bootEpoch: input.bootEpoch,
      configRevision: input.configRevision,
    }, input.requestBody);
    try {
      await this.materialize(
        session,
        input.endpoint,
        input.requestBody,
        input.requestId,
        input.signal,
      );
    } catch (error) {
      await session.saveMaterializationError(errorMessage(error));
    }
    return session;
  }

  private async materialize(
    session: LocalInferenceAuditSession,
    endpoint: string,
    requestBody: Uint8Array,
    requestId: string,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBody));
    } catch {
      throw new Error("request body is not valid UTF-8 JSON");
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("request body must be a JSON object");
    }
    const abort = new AbortController();
    const abortFromCaller = () => abort.abort(
      callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error("inference audit materialization was cancelled"),
    );
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => abort.abort(new Error("provider materialization timed out")),
      this.timeoutMs,
    );
    timer.unref?.();
    const base = endpoint.replace(/\/+$/, "");
    const headers = {
      "content-type": "application/json",
      "x-request-id": requestId,
    };
    try {
      const applied = await withAbort(this.fetchImpl(`${base}/apply-template`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: abort.signal,
      }), abort.signal);
      const appliedJson = await jsonResponse(applied, this.maxBytes, abort.signal);
      const prompt = typeof appliedJson === "object" && appliedJson !== null
        ? (appliedJson as Record<string, unknown>).prompt
        : undefined;
      if (typeof prompt !== "string") {
        throw new Error("provider apply-template response did not contain a prompt");
      }
      const tokenized = await withAbort(this.fetchImpl(`${base}/tokenize`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: prompt,
          add_special: true,
          parse_special: true,
          with_pieces: true,
        }),
        signal: abort.signal,
      }), abort.signal);
      const tokenizedJson = await jsonResponse(tokenized, this.maxBytes, abort.signal);
      const tokens = typeof tokenizedJson === "object" && tokenizedJson !== null
        ? (tokenizedJson as Record<string, unknown>).tokens
        : undefined;
      if (!Array.isArray(tokens)) {
        throw new Error("provider tokenize response did not contain a token array");
      }
      await session.saveMaterialization(prompt, tokens);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
