import { Hono, type Context } from "hono";
import type { RuntimeProtocol } from "@larm/core";
import { openAiErrorBody } from "../app-http";
import type { ModelBroker } from "../model-broker";

type GatewayOptions = {
  protocol: RuntimeProtocol;
  upstreamPath: string;
  bodyMode: "buffered" | "stream" | "none";
  maxBodyBytes: number;
};

export function registerInferenceRoutes(app: Hono, options: {
  modelBroker?: ModelBroker;
  gatewayMaxBodyBytes: number;
  embeddingMaxBodyBytes: number;
  handleGateway: (context: Context, request: GatewayOptions) => Response | Promise<Response>;
}): void {
  app.get("/v1/models", (c) => {
    if (!options.modelBroker) {
      return c.json(openAiErrorBody(
        "model_catalog_unavailable",
        "OpenAI-compatible model catalog is not configured",
      ), 503);
    }
    return c.json(options.modelBroker.listModels());
  });

  app.post("/v1/chat/completions", (c) => options.handleGateway(c, {
    protocol: "openai.chat-completions.v1",
    upstreamPath: "/v1/chat/completions",
    bodyMode: "buffered",
    maxBodyBytes: options.gatewayMaxBodyBytes,
  }));

  app.post("/v1/audio/speech", (c) => options.handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/speech",
    bodyMode: "buffered",
    maxBodyBytes: options.gatewayMaxBodyBytes,
  }));

  app.get("/v1/audio/voices", (c) => options.handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/voices",
    bodyMode: "none",
    maxBodyBytes: 0,
  }));

  app.post("/v1/embed", (c) => options.handleGateway(c, {
    protocol: "larm.embedding.v1",
    upstreamPath: "/embed",
    bodyMode: "buffered",
    maxBodyBytes: options.embeddingMaxBodyBytes,
  }));

  app.post("/v1/systemone", (c) => options.handleGateway(c, {
    protocol: "larm.system-one.v1",
    upstreamPath: "/v1/systemone",
    bodyMode: "buffered",
    maxBodyBytes: 2 * 1024 * 1024,
  }));
}
