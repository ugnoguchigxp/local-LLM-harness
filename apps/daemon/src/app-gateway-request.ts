import {
  audioSpeechRequestSchema,
  embeddingRequestSchema,
  systemOneRequestSchema,
  type AudioSpeechRequest,
  type EmbeddingRequest,
  type RuntimeProtocol,
  type SystemOneRequest,
} from "@larm/core";
import { normalizeQwen38ChatRequest } from "./app-http";
import { RequestBodyError, readBodyLimited } from "./http-body";

export type PreparedGatewayRequestBody = {
  chatRequest?: unknown;
  chatRequestBytes?: Uint8Array;
  chatResponseFormat?: "sse";
  speechRequest?: AudioSpeechRequest;
  speechRequestBytes?: Uint8Array;
  voicevoxOnlyParameter?: string;
  embeddingRequest?: EmbeddingRequest;
  embeddingRequestBytes?: Uint8Array;
  systemOneRequest?: SystemOneRequest;
  systemOneRequestBytes?: Uint8Array;
};

export type GatewayRequestBodyError = {
  status: number;
  code: string;
  message: string;
  format: "larm" | "openai";
  param?: string | null;
};

export type GatewayRequestBodyResult =
  | { ok: true; body: PreparedGatewayRequestBody }
  | { ok: false; error: GatewayRequestBodyError };

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function larmError(error: unknown): GatewayRequestBodyError {
  return error instanceof RequestBodyError
    ? { status: error.status, code: error.code, message: error.message, format: "larm" }
    : { status: 400, code: "bad_request", message: "request body must be valid UTF-8 JSON", format: "larm" };
}

function openAiError(error: unknown): GatewayRequestBodyError {
  return error instanceof RequestBodyError
    ? { status: error.status, code: error.code, message: error.message, format: "openai" }
    : { status: 400, code: "invalid_request", message: "request body must be valid UTF-8 JSON", format: "openai" };
}

export async function prepareGatewayRequestBody(input: {
  request: Request;
  protocol: RuntimeProtocol;
  bodyMode: "buffered" | "stream" | "none";
  maxBodyBytes: number;
}): Promise<GatewayRequestBodyResult> {
  const body: PreparedGatewayRequestBody = {};

  if (input.protocol === "larm.embedding.v1") {
    try {
      const bytes = await readBodyLimited(input.request.clone() as unknown as Request, input.maxBodyBytes);
      const parsed = embeddingRequestSchema.safeParse(decodeJson(bytes));
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            status: 400,
            code: "invalid_embedding_request",
            message: "texts, explicit type, normalize=true, and priority are required",
            format: "larm",
          },
        };
      }
      body.embeddingRequest = parsed.data;
      body.embeddingRequestBytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    } catch (error) {
      return { ok: false, error: larmError(error) };
    }
  }

  if (input.protocol === "larm.system-one.v1") {
    try {
      const bytes = await readBodyLimited(input.request.clone() as unknown as Request, input.maxBodyBytes);
      const parsed = systemOneRequestSchema.safeParse(decodeJson(bytes));
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            status: 400,
            code: "invalid_system_one_request",
            message: "model, state, and typed questions are required",
            format: "larm",
          },
        };
      }
      body.systemOneRequest = parsed.data;
      body.systemOneRequestBytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    } catch (error) {
      return { ok: false, error: larmError(error) };
    }
  }

  if (input.protocol === "openai.chat-completions.v1") {
    try {
      const bytes = await readBodyLimited(input.request.clone() as unknown as Request, input.maxBodyBytes);
      body.chatRequest = normalizeQwen38ChatRequest(decodeJson(bytes));
      body.chatRequestBytes = new TextEncoder().encode(JSON.stringify(body.chatRequest));
      if (
        body.chatRequest
        && typeof body.chatRequest === "object"
        && !Array.isArray(body.chatRequest)
        && (body.chatRequest as Record<string, unknown>).stream === true
      ) {
        body.chatResponseFormat = "sse";
      }
    } catch (error) {
      return { ok: false, error: larmError(error) };
    }
  }

  if (input.protocol === "openai.audio-speech.v1" && input.bodyMode !== "none") {
    try {
      body.speechRequestBytes = await readBodyLimited(
        input.request.clone() as unknown as Request,
        input.maxBodyBytes,
      );
      const parsed = audioSpeechRequestSchema.safeParse(decodeJson(body.speechRequestBytes));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          ok: false,
          error: {
            status: 400,
            code: "invalid_request",
            message: "speech request parameters are invalid",
            param: typeof issue?.path[0] === "string" ? issue.path[0] : null,
            format: "openai",
          },
        };
      }
      body.speechRequest = parsed.data;
      if (
        parsed.data.model === "voicevox-core"
        && parsed.data.speed !== undefined
        && (parsed.data.speed < 0.5 || parsed.data.speed > 2)
      ) {
        return {
          ok: false,
          error: {
            status: 400,
            code: "invalid_request",
            message: "speed must be between 0.5 and 2 for voicevox-core",
            param: "speed",
            format: "openai",
          },
        };
      }
      body.voicevoxOnlyParameter = ["style", "pitch_scale", "intonation_scale"]
        .find((name) => parsed.data[name as keyof typeof parsed.data] !== undefined);
      if (body.voicevoxOnlyParameter && parsed.data.model !== "voicevox-core") {
        return {
          ok: false,
          error: {
            status: 400,
            code: "unsupported_parameter",
            message: `${body.voicevoxOnlyParameter} is supported only by voicevox-core`,
            param: body.voicevoxOnlyParameter,
            format: "openai",
          },
        };
      }
    } catch (error) {
      return { ok: false, error: openAiError(error) };
    }
  }

  return { ok: true, body };
}
