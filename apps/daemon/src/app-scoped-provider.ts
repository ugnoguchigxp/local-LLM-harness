import type { RuntimeProtocol } from "@larm/core";
import type { PreparedGatewayRequestBody } from "./app-gateway-request";
import { RequestBodyError, readBodyLimited } from "./http-body";

export type ScopedProviderModelValidation =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/** Confirms every scoped Provider request names only the model bound to its claim. */
export async function validateScopedProviderModel(input: {
  request: Request;
  protocol: RuntimeProtocol;
  maxBodyBytes: number;
  publicModel: string;
  prepared: PreparedGatewayRequestBody;
}): Promise<ScopedProviderModelValidation> {
  try {
    let modelValues: unknown[] = [];
    if (input.protocol === "larm.embedding.v1") {
      modelValues = [input.publicModel];
    } else if (input.protocol === "larm.system-one.v1") {
      modelValues = input.prepared.systemOneRequest ? [input.prepared.systemOneRequest.model] : [];
    } else if (input.protocol === "openai.chat-completions.v1") {
      const request = input.prepared.chatRequest;
      modelValues = typeof request === "object" && request !== null && !Array.isArray(request)
        ? [(request as Record<string, unknown>).model]
        : [];
    } else if (input.protocol === "openai.audio-speech.v1") {
      modelValues = input.prepared.speechRequest ? [input.prepared.speechRequest.model] : [];
    } else {
      const clone = input.request.clone();
      const bytes = await readBodyLimited(clone as unknown as Request, input.maxBodyBytes);
      const parsedRequest = new Response(bytes, {
        headers: { "content-type": clone.headers.get("content-type") ?? "" },
      });
      const form = await parsedRequest.formData();
      modelValues = form.getAll("model");
    }
    if (
      modelValues.length !== 1
      || typeof modelValues[0] !== "string"
      || modelValues[0] !== input.publicModel
    ) {
      return {
        ok: false,
        status: 400,
        code: "model_mismatch",
        message: `model must equal ${input.publicModel}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return { ok: false, status: error.status, code: error.code, message: error.message };
    }
    return {
      ok: false,
      status: 400,
      code: "bad_request",
      message: "request body could not be validated",
    };
  }
}
