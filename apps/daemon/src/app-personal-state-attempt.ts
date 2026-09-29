import type { PersonalStateScope, RuntimeProtocol } from "@larm/core";
import { personalStateSubjectDigest } from "@larm/core";
import type { Context } from "hono";
import type { VerifiedProviderToken } from "./agent-connection-controller";
import type { ContextController } from "./context-controller";
import type { PersonalStateController } from "./personal-state-controller";
import { errorBody } from "./app-http";

export type StartedPersonalStateAttempt = Awaited<
  ReturnType<PersonalStateController["beginAttempt"]>
>;

export type PersonalStateAttemptContext = {
  principal?: string;
  attempt?: StartedPersonalStateAttempt;
  controller?: PersonalStateController;
  subjectDigest?: string;
  sourceDigests?: string[];
  onForwarded?: () => Promise<void>;
  onTerminal?: (result: { outcome: string; upstreamStatus?: number }) => Promise<void>;
};

export async function preparePersonalStateAttempt(input: {
  context: Context;
  protocol: RuntimeProtocol;
  attemptId?: string;
  allocationId: string;
  runtime: string;
  release?: string;
  contextViewId?: string;
  scopedPrincipal?: string;
  chatRequest?: unknown;
  principal: () => string;
  getFeature: (
    context: Context,
    scope: PersonalStateScope,
    allocationId?: string,
  ) => { controller: PersonalStateController; caller: VerifiedProviderToken } | Response;
  getContextController: () => ContextController | undefined;
  handleError: (context: Context, error: unknown) => Response;
}): Promise<{ ok: true; value: PersonalStateAttemptContext } | { ok: false; response: Response }> {
  const requestPrincipal = input.scopedPrincipal
    ?? ((input.contextViewId || input.attemptId !== undefined) ? input.principal() : undefined);
  let attempt: StartedPersonalStateAttempt | undefined;
  let controller: PersonalStateController | undefined;

  if (input.attemptId !== undefined) {
    const request = input.chatRequest;
    if (
      input.protocol !== "openai.chat-completions.v1"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.attemptId)
      || !input.release
      || !request
      || typeof request !== "object"
      || Array.isArray(request)
    ) {
      return {
        ok: false,
        response: input.context.json(
          errorBody("personal_state_request_invalid", "generation attempt headers are invalid"),
          400,
        ),
      };
    }
    const feature = input.getFeature(input.context, "context.generate", input.allocationId);
    if (feature instanceof Response) return { ok: false, response: feature };
    controller = feature.controller;
    try {
      attempt = await controller.beginAttempt({
        principal: feature.caller.record.principal,
        attemptId: input.attemptId,
        allocationId: input.allocationId,
        runtime: input.runtime,
        release: input.release,
        ...(input.contextViewId ? { viewId: input.contextViewId } : {}),
        request: request as Record<string, unknown>,
      });
    } catch (error) {
      return { ok: false, response: input.handleError(input.context, error) };
    }
  }

  const subjectDigest = attempt && requestPrincipal
    ? personalStateSubjectDigest(requestPrincipal)
    : undefined;
  const viewBinding = input.contextViewId && requestPrincipal
    ? input.getContextController()?.viewPersonalStateBinding(requestPrincipal, input.contextViewId)
    : undefined;

  return {
    ok: true,
    value: {
      ...(requestPrincipal ? { principal: requestPrincipal } : {}),
      ...(attempt ? { attempt } : {}),
      ...(controller ? { controller } : {}),
      ...(subjectDigest ? { subjectDigest } : {}),
      ...(viewBinding ? { sourceDigests: viewBinding.sourceDigests } : {}),
      ...(attempt && controller && subjectDigest ? {
        onForwarded: async () => {
          await controller!.markAttemptForwarded(subjectDigest, attempt!.attempt.attemptId);
        },
        onTerminal: async (result: { outcome: string; upstreamStatus?: number }) => {
          await controller!.finishAttempt({
            subjectDigest,
            attemptId: attempt!.attempt.attemptId,
            succeeded: result.outcome === "http_200" && result.upstreamStatus === 200,
            cancelled: [
              "attempt_cancelled",
              "client_cancelled",
              "timeout",
              "binding_invalidated",
            ].includes(result.outcome),
            transportClosed: !/^http_[1-5][0-9]{2}$/.test(result.outcome),
            outcome: result.outcome,
          });
        },
      } : {}),
    },
  };
}
