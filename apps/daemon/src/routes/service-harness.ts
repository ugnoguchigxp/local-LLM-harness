import { Hono, type Context } from "hono";
import { SAAA_SERVICE_HARNESS_CONTRACT_VERSION } from "@larm/core";
import { errorBody } from "../app-http";
import type { RuntimeDefinition } from "@larm/core";
import { SERVICE_HARNESS_ASR_MODEL } from "../app-auth";

export function registerServiceHarnessRoutes(app: Hono, options: {
  asrRuntime?: RuntimeDefinition;
  getConfigRevision: () => string;
  isAsrReady: () => boolean;
  speechMaxBodyBytes: number;
  handleGateway: (context: Context, request: {
    protocol: "openai.audio-transcriptions.v1";
    upstreamPath: string;
    bodyMode: "stream";
    maxBodyBytes: number;
  }) => Response | Promise<Response>;
  handleTranscription: (context: Context) => Response | Promise<Response>;
}): void {
  app.get("/v1/services", (c) => {
    c.header("cache-control", "no-store");
    const origin = new URL(c.req.url).origin;
    const asr = options.asrRuntime;
    return c.json({
      contractVersion: SAAA_SERVICE_HARNESS_CONTRACT_VERSION,
      revision: options.getConfigRevision(),
      services: asr
        && asr.protocol === "openai.audio-transcriptions.v1"
        && asr.capability.includes("speech.stt")
        ? [{
          capability: "asr" as const,
          protocol: "openai.audio-transcriptions.v1" as const,
          baseUrl: `${origin}/v1`,
          model: SERVICE_HARNESS_ASR_MODEL,
          language: "auto" as const,
          healthUrl: `${origin}/v1/services/asr/health`,
        }]
        : [],
    });
  });

  app.get("/v1/services/asr/health", (c) => {
    c.header("cache-control", "no-store");
    if (!options.isAsrReady()) {
      return c.json(errorBody("asr_unavailable", "ASR service is not ready"), 503);
    }
    return c.json({ status: "ok" as const, model: SERVICE_HARNESS_ASR_MODEL });
  });

  app.post("/v1/audio/transcriptions", (c) => {
    const authorization = c.req.header("authorization");
    const providerBearer = authorization?.startsWith("Bearer larm_conn_v1.") === true;
    const bearer = authorization?.startsWith("Bearer ") === true;
    if (c.req.header("x-larm-allocation-id") === undefined && !providerBearer && !bearer) {
      return options.handleTranscription(c);
    }
    return options.handleGateway(c, {
      protocol: "openai.audio-transcriptions.v1",
      upstreamPath: "/v1/audio/transcriptions",
      bodyMode: "stream",
      maxBodyBytes: options.speechMaxBodyBytes,
    });
  });
}
