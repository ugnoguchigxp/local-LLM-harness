import {
  audioVoiceListSchema,
  OpenAiChatCompletionSseInspector,
  type AudioSpeechRequest,
  type AudioVoiceList,
  type OpenAiChatCompletionSseChunk,
} from "@larm/core";
import { LarmStreamProtocolError } from "./errors";

type RequestOptions = { signal?: AbortSignal };
type Request = (path: string, init: RequestInit) => Promise<Response>;

export class ClientMedia {
  constructor(private readonly request: Request) {}

  createChatCompletion(body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  async *streamChatCompletion(
    body: Record<string, unknown>,
    options: RequestOptions = {},
  ): AsyncGenerator<OpenAiChatCompletionSseChunk> {
    const response = await this.createChatCompletion({ ...body, stream: true }, options);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/event-stream") {
      await response.body?.cancel(new Error("stream content type mismatch")).catch(() => undefined);
      throw new LarmStreamProtocolError(
        "stream_content_type_invalid",
        "Chat Completions stream did not return text/event-stream",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new LarmStreamProtocolError("stream_body_missing", "Chat Completions stream has no body");
    }
    const pending: OpenAiChatCompletionSseChunk[] = [];
    const inspector = new OpenAiChatCompletionSseInspector((chunk) => pending.push(chunk));
    let completed = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const progress = inspector.push(next.value);
        if (!progress.ok) {
          throw new LarmStreamProtocolError(
            `stream_${progress.reason}`,
            `Chat Completions stream failed validation: ${progress.reason}`,
          );
        }
        while (pending.length > 0) yield pending.shift()!;
      }
      const inspected = inspector.finish();
      if (!inspected.ok) {
        throw new LarmStreamProtocolError(
          `stream_${inspected.reason}`,
          `Chat Completions stream failed validation: ${inspected.reason}`,
        );
      }
      while (pending.length > 0) yield pending.shift()!;
      completed = true;
    } finally {
      if (!completed) await reader.cancel(new Error("stream consumer stopped")).catch(() => undefined);
      reader.releaseLock();
    }
  }

  createAudioTranscription(body: RequestInit["body"], options: RequestOptions = {}): Promise<Response> {
    return this.request("/v1/audio/transcriptions", {
      method: "POST",
      body,
      signal: options.signal,
    });
  }

  createSpeech(body: AudioSpeechRequest, options: RequestOptions = {}): Promise<Response> {
    return this.request("/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  listVoices(model: string, options: RequestOptions = {}): Promise<Response> {
    const query = new URLSearchParams({ model });
    return this.request(`/v1/audio/voices?${query.toString()}`, { signal: options.signal });
  }

  async getVoicevoxCatalog(options: RequestOptions = {}): Promise<AudioVoiceList> {
    const response = await this.listVoices("voicevox-core", options);
    return audioVoiceListSchema.parse(await response.json());
  }

  chat(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.gateway("/v1/chat/completions", allocationId, body, options);
  }

  chatWithContext(
    allocationId: string,
    viewId: string,
    body: unknown,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-larm-allocation-id": allocationId,
        "x-larm-context-view-id": viewId,
        ...(capability ? { "x-larm-capability": capability } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  speech(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.gateway("/v1/audio/speech", allocationId, body, options);
  }

  transcribe(
    allocationId: string,
    body: RequestInit["body"],
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "x-larm-allocation-id": allocationId },
      body,
      signal: options.signal,
    });
  }

  voices(
    allocationId: string,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/audio/voices", {
      headers: {
        "x-larm-allocation-id": allocationId,
        ...(capability ? { "x-larm-capability": capability } : {}),
      },
      signal: options.signal,
    });
  }

  private gateway(
    path: string,
    allocationId: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-larm-allocation-id": allocationId,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }
}
