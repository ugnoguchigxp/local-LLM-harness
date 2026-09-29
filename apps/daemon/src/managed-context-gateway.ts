import type { Context } from "hono";
import { GatewayRequestPreparationError } from "./gateway";
import { ContextControllerError } from "./context-controller";
import type { ContextController } from "./context-controller";

export function createManagedContextRequestPreparer(input: {
  context: Context;
  getController: (context: Context) => ContextController | Response;
  viewId: string;
  principal: string;
  allocationId: string;
  runtime: string;
  release: string;
  attemptId?: string;
}): (body: Uint8Array, signal: AbortSignal) => Promise<Uint8Array> {
  return async (body, signal) => {
    const controller = input.getController(input.context);
    if (controller instanceof Response) {
      throw new GatewayRequestPreparationError(
        controller.status,
        "context_not_configured",
        "managed context is not configured",
      );
    }
    try {
      return await controller.prepareChatRequest({
        viewId: input.viewId,
        principal: input.principal,
        allocationId: input.allocationId,
        runtime: input.runtime,
        release: input.release,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        requestBody: body,
        signal,
      });
    } catch (error) {
      if (error instanceof ContextControllerError) {
        throw new GatewayRequestPreparationError(error.status, error.code, error.message);
      }
      throw error;
    }
  };
}
