import type { RuntimeProtocol } from "@larm/core";
import type { Context } from "hono";
import type { AgentConnectionController, VerifiedProviderToken } from "./agent-connection-controller";
import { ConnectionTokenError } from "./connection-token";
import type { ControlPlane } from "./controller";
import { errorBody, openAiErrorBody } from "./app-http";
import { secretMatches } from "./app-auth";
import { prepareGatewayRequestBody, type PreparedGatewayRequestBody } from "./app-gateway-request";
import { validateScopedProviderModel } from "./app-scoped-provider";
import { RequestBodyError, readBodyLimited } from "./http-body";

export type GatewayRouteOptions = {
  protocol: RuntimeProtocol;
  upstreamPath: string;
  bodyMode: "buffered" | "stream" | "none";
  maxBodyBytes: number;
  capability?: string;
};

export type GatewayIngress = {
  declaredAllocationId?: string;
  contextViewId?: string;
  attemptId?: string;
  providerToken?: string;
  scoped?: VerifiedProviderToken;
  exclusiveExecution: boolean;
  prepared: PreparedGatewayRequestBody;
  directModel?: string;
  directRequestBytes?: Uint8Array;
  directSpeechFormat?: string;
};

export type GatewayIngressResult =
  | { ok: true; ingress: GatewayIngress }
  | { ok: false; response: Response };

export async function prepareGatewayIngress(input: {
  context: Context;
  route: GatewayRouteOptions;
  control: Pick<ControlPlane, "isDraining">;
  managementToken?: string;
  modelBrokerConfigured: boolean;
  agentFeature: (context: Context) => AgentConnectionController | Response;
}): Promise<GatewayIngressResult> {
  const { context: c, route: options } = input;
  if (input.control.isDraining()) {
    return { ok: false, response: c.json(errorBody("draining", "control plane is draining"), 503) };
  }
  const exclusiveHeader = c.req.header("x-larm-exclusive-execution");
  if (exclusiveHeader !== undefined && exclusiveHeader !== "true") {
    return {
      ok: false,
      response: c.json(errorBody("invalid_request", "x-larm-exclusive-execution must equal true"), 400),
    };
  }
  const exclusiveExecution = exclusiveHeader === "true";
  if (exclusiveExecution && (
    !input.managementToken
    || !secretMatches(c.req.header("x-larm-management-token"), input.managementToken)
  )) {
    return {
      ok: false,
      response: c.json(errorBody("forbidden", "exclusive execution requires a valid management token"), 403),
    };
  }

  const declaredAllocationId = c.req.header("x-larm-allocation-id");
  const contextViewId = c.req.header("x-larm-context-view-id");
  const attemptId = c.req.header("x-larm-attempt-id");
  if (contextViewId !== undefined) {
    if (options.protocol !== "openai.chat-completions.v1") {
      return {
        ok: false,
        response: c.json(errorBody("context_request_invalid", "context views are valid only for Chat Completions"), 400),
      };
    }
    if (!/^view_[a-zA-Z0-9._-]{1,186}$/.test(contextViewId)) {
      return {
        ok: false,
        response: c.json(errorBody("context_request_invalid", "x-larm-context-view-id is invalid"), 400),
      };
    }
    if (declaredAllocationId === undefined) {
      return {
        ok: false,
        response: c.json(errorBody("allocation_required", "context views require x-larm-allocation-id"), 400),
      };
    }
  }

  const authorization = c.req.header("authorization");
  const providerToken = authorization?.startsWith("Bearer larm_conn_v1.")
    ? authorization.slice(7)
    : undefined;
  let scoped: VerifiedProviderToken | undefined;
  if (providerToken) {
    const feature = input.agentFeature(c);
    if (feature instanceof Response) return { ok: false, response: feature };
    try {
      scoped = feature.verifyProviderToken(providerToken);
    } catch (error) {
      if (error instanceof ConnectionTokenError) {
        const idleReleased = error.code === "connection_idle_released";
        return {
          ok: false,
          response: c.json(
            errorBody(idleReleased ? error.code : "unauthorized", error.message),
            idleReleased ? 409 : 401,
          ),
        };
      }
      throw error;
    }
    if (scoped.provider.protocol !== options.protocol) {
      return {
        ok: false,
        response: c.json(errorBody("connection_forbidden", "provider token is not valid for this endpoint"), 403),
      };
    }
    if (declaredAllocationId !== undefined && declaredAllocationId !== scoped.record.allocationId) {
      return {
        ok: false,
        response: c.json(errorBody("connection_forbidden", "allocation header does not match provider token"), 403),
      };
    }
    const declaredCapability = c.req.header("x-larm-capability");
    if (declaredCapability !== undefined && declaredCapability !== scoped.provider.capability) {
      return {
        ok: false,
        response: c.json(errorBody("connection_forbidden", "capability header does not match provider token"), 403),
      };
    }
  }
  if (attemptId !== undefined && declaredAllocationId === undefined && !scoped) {
    return {
      ok: false,
      response: c.json(errorBody(
        "allocation_required",
        "generation attempts require an explicit allocation or claimed provider",
      ), 400),
    };
  }
  if ((options.protocol === "larm.embedding.v1" || options.protocol === "larm.system-one.v1") && !scoped) {
    return {
      ok: false,
      response: c.json(errorBody(
        "connection_provider_token_required",
        "this endpoint requires a claimed provider bearer token",
      ), 401),
    };
  }

  const preparedRequest = await prepareGatewayRequestBody({
    request: c.req.raw as unknown as Request,
    protocol: options.protocol,
    bodyMode: options.bodyMode,
    maxBodyBytes: options.maxBodyBytes,
  });
  if (!preparedRequest.ok) {
    const { error } = preparedRequest;
    return {
      ok: false,
      response: error.format === "openai"
        ? c.json(openAiErrorBody(error.code, error.message, error.param), error.status as 400 | 413 | 415)
        : c.json(errorBody(error.code, error.message), error.status as 400 | 413 | 415),
    };
  }

  let directModel: string | undefined;
  let directRequestBytes: Uint8Array | undefined;
  let directSpeechFormat: string | undefined;
  const prepared = preparedRequest.body;
  if (!scoped && declaredAllocationId === undefined && input.modelBrokerConfigured) {
    if (options.protocol === "openai.audio-speech.v1" && options.bodyMode === "none") {
      const searchParams = new URL(c.req.url).searchParams;
      const models = searchParams.getAll("model");
      if (models.length !== 1 || models[0]!.length === 0 || [...searchParams].length !== 1) {
        return {
          ok: false,
          response: c.json(openAiErrorBody(
            "invalid_request",
            "exactly one model query parameter and no other query parameters are required",
            "model",
          ), 400),
        };
      }
      directModel = models[0];
    } else if (options.protocol === "openai.audio-speech.v1") {
      directRequestBytes = prepared.speechRequestBytes;
      directModel = prepared.speechRequest?.model;
      directSpeechFormat = prepared.speechRequest?.response_format;
    } else if (options.protocol === "openai.audio-transcriptions.v1") {
      try {
        directRequestBytes = await readBodyLimited(
          c.req.raw.clone() as unknown as Request,
          options.maxBodyBytes,
        );
        const parsedRequest = new Response(directRequestBytes, {
          headers: { "content-type": c.req.header("content-type") ?? "" },
        });
        const form = await parsedRequest.formData();
        const models = form.getAll("model");
        const files = form.getAll("file");
        if (models.length !== 1 || typeof models[0] !== "string" || models[0].length === 0) {
          return {
            ok: false,
            response: c.json(openAiErrorBody("invalid_request", "exactly one model field is required", "model"), 400),
          };
        }
        if (files.length !== 1 || !(files[0] instanceof Blob) || files[0].size === 0) {
          return {
            ok: false,
            response: c.json(openAiErrorBody("invalid_request", "exactly one non-empty file is required", "file"), 400),
          };
        }
        directModel = models[0];
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return { ok: false, response: c.json(openAiErrorBody(error.code, error.message), error.status) };
        }
        return {
          ok: false,
          response: c.json(openAiErrorBody("invalid_request", "request must be valid multipart form data"), 400),
        };
      }
    }
  }
  if (scoped) {
    const modelValidation = await validateScopedProviderModel({
      request: c.req.raw,
      protocol: options.protocol,
      maxBodyBytes: options.maxBodyBytes,
      publicModel: scoped.provider.publicModel,
      prepared,
    });
    if (!modelValidation.ok) {
      return {
        ok: false,
        response: c.json(errorBody(modelValidation.code, modelValidation.message), modelValidation.status as 400 | 413),
      };
    }
  }

  return {
    ok: true,
    ingress: {
      ...(declaredAllocationId !== undefined ? { declaredAllocationId } : {}),
      ...(contextViewId !== undefined ? { contextViewId } : {}),
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...(providerToken !== undefined ? { providerToken } : {}),
      ...(scoped ? { scoped } : {}),
      exclusiveExecution,
      prepared,
      ...(directModel !== undefined ? { directModel } : {}),
      ...(directRequestBytes ? { directRequestBytes } : {}),
      ...(directSpeechFormat !== undefined ? { directSpeechFormat } : {}),
    },
  };
}
