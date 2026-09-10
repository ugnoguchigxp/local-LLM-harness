import { createHash } from "node:crypto";

export const CONTEXT_TOKENIZER_PROBE_CORPUS = [
  "hello",
  "日本語の文脈テスト",
  "line one\nline two",
  "<|im_start|>system",
  "emoji 🧠 context",
] as const;

export type ContextTokenizerIdentity = {
  engineBuild: string;
  contextLimitTokens: number;
  chatTemplateDigest: string;
  tokenizerDigest: string;
};

export class ContextTokenizerError extends Error {
  constructor(
    readonly code:
      | "context_tokenizer_unavailable"
      | "context_tokenizer_response_invalid"
      | "context_tokenizer_identity_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ContextTokenizerError";
  }
}

function endpointUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/$/, "")}${path}`;
}

async function jsonRequest(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    throw new ContextTokenizerError(
      "context_tokenizer_unavailable",
      `context tokenizer request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ContextTokenizerError(
      "context_tokenizer_unavailable",
      `context tokenizer returned HTTP ${response.status}`,
    );
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ContextTokenizerError(
      "context_tokenizer_response_invalid",
      "context tokenizer response must be application/json",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ContextTokenizerError(
      "context_tokenizer_response_invalid",
      "context tokenizer returned invalid JSON",
    );
  }
}

function tokensFrom(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { tokens?: unknown }).tokens)) {
    throw new ContextTokenizerError(
      "context_tokenizer_response_invalid",
      "context tokenizer response has no token array",
    );
  }
  const tokens = (value as { tokens: unknown[] }).tokens;
  if (tokens.length > 100_000_000 || tokens.some((token) => {
    if (Number.isSafeInteger(token)) return false;
    if (!token || typeof token !== "object" || !Number.isSafeInteger((token as { id?: unknown }).id)) {
      return true;
    }
    const piece = (token as { piece?: unknown }).piece;
    return typeof piece !== "string"
      && !(Array.isArray(piece) && piece.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
  })) {
    throw new ContextTokenizerError(
      "context_tokenizer_response_invalid",
      "context tokenizer returned an invalid token array",
    );
  }
  return tokens;
}

export class LlamaContextTokenizer {
  async tokenize(
    endpoint: string,
    content: string,
    options: { withPieces?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const result = await jsonRequest(endpointUrl(endpoint, "/tokenize"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        add_special: false,
        with_pieces: options.withPieces ?? false,
      }),
    }, options.signal);
    tokensFrom(result);
    return result;
  }

  async countSourceTokens(endpoint: string, content: string, signal?: AbortSignal): Promise<number> {
    return tokensFrom(await this.tokenize(endpoint, content, { signal })).length;
  }

  async countChatTokens(
    endpoint: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number> {
    const templated = await jsonRequest(endpointUrl(endpoint, "/apply-template"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, signal);
    const prompt = templated && typeof templated === "object"
      ? (templated as { prompt?: unknown }).prompt
      : undefined;
    if (typeof prompt !== "string") {
      throw new ContextTokenizerError(
        "context_tokenizer_response_invalid",
        "chat template response has no prompt",
      );
    }
    return await this.countSourceTokens(endpoint, prompt, signal);
  }

  async identity(endpoint: string, signal?: AbortSignal): Promise<ContextTokenizerIdentity> {
    const props = await jsonRequest(endpointUrl(endpoint, "/props"), { method: "GET" }, signal);
    if (!props || typeof props !== "object") {
      throw new ContextTokenizerError("context_tokenizer_response_invalid", "runtime props are invalid");
    }
    const value = props as Record<string, unknown>;
    const settings = value.default_generation_settings as Record<string, unknown> | undefined;
    const chatTemplate = value.chat_template;
    const engineBuild = value.build_info;
    const contextLimitTokens = settings?.n_ctx;
    if (
      typeof chatTemplate !== "string"
      || typeof engineBuild !== "string"
      || !Number.isSafeInteger(contextLimitTokens)
      || (contextLimitTokens as number) < 1
    ) {
      throw new ContextTokenizerError(
        "context_tokenizer_response_invalid",
        "runtime props omit context identity fields",
      );
    }
    const probes: unknown[] = [];
    for (const content of CONTEXT_TOKENIZER_PROBE_CORPUS) {
      probes.push(await this.tokenize(endpoint, content, { withPieces: true, signal }));
    }
    return {
      engineBuild,
      contextLimitTokens: contextLimitTokens as number,
      chatTemplateDigest: createHash("sha256").update(chatTemplate).digest("hex"),
      tokenizerDigest: createHash("sha256")
        .update(`${probes.map((probe) => JSON.stringify(probe)).join("\n")}\n`)
        .digest("hex"),
    };
  }
}
