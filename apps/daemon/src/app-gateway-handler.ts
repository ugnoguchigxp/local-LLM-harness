import type { PersonalStateScope } from "@larm/core";
import type { Context } from "hono";
import type { AppDeps } from "./app-types";
import type { AgentConnectionController, VerifiedProviderToken } from "./agent-connection-controller";
import type { ContextController } from "./context-controller";
import type { DaemonIdentity } from "./identity";
import type { ExecutionGate } from "./execution-gate";
import type { ModelBroker } from "./model-broker";
import type { PersonalStateController } from "./personal-state-controller";
import { proxyGateway } from "./gateway";
import { handleModelBrokerGateway } from "./app-model-broker-gateway";
import { beginGatewayProviderRequest } from "./gateway-request-lifecycle";
import { createManagedContextRequestPreparer } from "./managed-context-gateway";
import { resolveGatewayAllocation } from "./app-allocation-gateway";
import { prepareGatewayIngress, type GatewayRouteOptions } from "./app-gateway-ingress";
import { preparePersonalStateAttempt } from "./app-personal-state-attempt";
import { errorBody } from "./app-http";

export function createGatewayHandler(input: {
  deps: AppDeps;
  identity: DaemonIdentity;
  executionGate: ExecutionGate;
  modelBroker?: ModelBroker;
  agentConnections?: AgentConnectionController;
  agentFeature: (context: Context) => AgentConnectionController | Response;
  principal: () => string;
  contextFeature: (context: Context) => ContextController | Response;
  personalStateFeature: (
    context: Context,
    scope: PersonalStateScope,
    allocationId?: string,
  ) => { controller: PersonalStateController; caller: VerifiedProviderToken } | Response;
  personalStateError: (context: Context, error: unknown) => Response;
}) {
  const {
    deps,
    identity,
    executionGate,
    modelBroker,
    agentConnections,
    agentFeature,
    principal,
    contextFeature,
    personalStateFeature,
    personalStateError,
  } = input;

  return async (c: Context, options: GatewayRouteOptions): Promise<Response> => {
    const ingressResult = await prepareGatewayIngress({
      context: c,
      route: options,
      control: deps.control,
      managementToken: deps.managementToken,
      modelBrokerConfigured: modelBroker !== undefined,
      agentFeature,
    });
    if (!ingressResult.ok) return ingressResult.response;
    const {
      declaredAllocationId,
      contextViewId,
      attemptId,
      providerToken,
      scoped,
      exclusiveExecution,
      directModel,
      directRequestBytes,
      directSpeechFormat,
      prepared,
    } = ingressResult.ingress;
    const {
      chatRequest,
      chatRequestBytes,
      chatResponseFormat,
      speechRequestBytes,
      voicevoxOnlyParameter,
      embeddingRequest,
      embeddingRequestBytes,
      systemOneRequest,
      systemOneRequestBytes,
    } = prepared;
    const brokeredResponse = await handleModelBrokerGateway({
      context: c,
      route: options,
      broker: modelBroker,
      registry: deps.registry,
      control: deps.control,
      identity,
      executionGate,
      gatewayTimeoutMs: deps.gatewayTimeoutMs,
      gatewayFetch: deps.gatewayFetch,
      metrics: deps.metrics,
      requestTracker: deps.requestTracker,
      getConfigRevision: deps.getConfigRevision,
      now: deps.now,
      random: deps.random,
      onEvent: deps.onEvent,
      inferenceAuditMode: deps.inferenceAuditMode,
      inferenceAuditRecorder: deps.inferenceAuditRecorder,
      exclusiveExecution,
      scopedProvider: scoped !== undefined,
      declaredAllocationId,
      directModel,
      directRequestBytes: directRequestBytes ?? chatRequestBytes,
      chatRequest,
      chatResponseFormat,
      expectedSpeechFormat: directSpeechFormat,
    });
    if (brokeredResponse) return brokeredResponse;
    const allocationResolution = resolveGatewayAllocation({
      context: c,
      registry: deps.registry,
      control: deps.control,
      protocol: options.protocol,
      routeCapability: options.capability,
      declaredAllocationId,
      scoped,
      capabilityHeader: c.req.header("x-larm-capability"),
      contextViewId,
      voicevoxOnlyParameter,
      metrics: deps.metrics,
      onEvent: deps.onEvent,
    });
    if (!allocationResolution.ok) return allocationResolution.response;
    const { allocationId, allocation, selected, runtime, release } = allocationResolution;
    const personalStateAttempt = await preparePersonalStateAttempt({
      context: c,
      protocol: options.protocol,
      attemptId,
      allocationId,
      runtime: runtime.id,
      release,
      contextViewId,
      scopedPrincipal: scoped?.record.principal,
      chatRequest,
      principal,
      getFeature: personalStateFeature,
      getContextController: () => deps.contextController,
      handleError: personalStateError,
    });
    if (!personalStateAttempt.ok) return personalStateAttempt.response;
    const {
      principal: requestPrincipal,
      attempt: personalAttempt,
      subjectDigest: attemptSubjectDigest,
      sourceDigests: auditSourceDigests,
      onForwarded,
      onTerminal,
    } = personalStateAttempt.value;
    if (options.protocol === "larm.embedding.v1") {
      if (
        !embeddingRequest
        || !embeddingRequestBytes
        || !scoped?.provider.embeddingSpace
        || !runtime.embedding
        || JSON.stringify(scoped.provider.embeddingSpace) !== JSON.stringify(runtime.embedding)
      ) {
        return c.json(errorBody(
          "embedding_space_mismatch",
          "claimed and resolved embedding spaces do not match",
        ), 409);
      }
    }

    const gatewayRequest = beginGatewayProviderRequest({
      allocationId,
      capability: selected.binding.capability,
      protocol: options.protocol,
      bodyMode: options.bodyMode,
      scoped,
      connections: agentConnections,
      control: deps.control,
      random: deps.random,
    });
    if (!gatewayRequest.ok) {
      return c.json(errorBody(
        gatewayRequest.code,
        "agent connection is no longer active",
      ), 409);
    }
    const releaseProviderRequest = gatewayRequest.release;
    try {
      return await proxyGateway({
        request: c.req.raw,
        ...((systemOneRequestBytes ?? embeddingRequestBytes ?? chatRequestBytes ?? speechRequestBytes)
          ? { requestBody: systemOneRequestBytes ?? embeddingRequestBytes ?? chatRequestBytes ?? speechRequestBytes }
          : {}),
        ...(contextViewId
          ? {
            prepareRequestBody: createManagedContextRequestPreparer({
              context: c,
              getController: contextFeature,
              viewId: contextViewId,
              principal: requestPrincipal!,
              allocationId,
              runtime: runtime.id,
              release: release!,
              ...(personalAttempt ? { attemptId: personalAttempt.attempt.attemptId } : {}),
            }),
          }
          : {}),
        allocationId,
        protocol: options.protocol,
        upstreamPath: options.upstreamPath,
        runtime,
        bodyMode: options.bodyMode,
        maxBodyBytes: options.maxBodyBytes,
        timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
        bootEpoch: identity.bootEpoch,
        executionGate,
        fetchImpl: deps.gatewayFetch,
        metrics: deps.metrics,
        requestTracker: deps.requestTracker,
        lifecycleSignal: deps.control.getAllocationSignal(allocationId),
        ...(personalAttempt ? {
          requestId: personalAttempt.attempt.larmRequestId,
          attemptSignal: personalAttempt.signal,
          onForwarded,
        } : {}),
        priority: allocation.priority ?? 0,
        exclusiveExecution,
        now: deps.now,
        random: deps.random,
        onEvent: deps.onEvent,
        inferenceAuditMode: deps.inferenceAuditMode,
        inferenceAuditRecorder: deps.inferenceAuditRecorder,
        auditContext: {
          capability: selected.binding.capability,
          route: selected.binding.route,
          ...(selected.binding.release ? { runtimeRelease: selected.binding.release } : {}),
          configRevision: allocation.catalogRevision
            ?? deps.getConfigRevision?.()
            ?? identity.configRevision,
          ...(personalAttempt && attemptSubjectDigest ? {
            personalState: {
              subjectDigest: attemptSubjectDigest,
              attemptId: personalAttempt.attempt.attemptId,
              ...(contextViewId ? { viewId: contextViewId } : {}),
              requestDigest: personalAttempt.attempt.requestDigest,
              sourceDigests: auditSourceDigests ?? [],
              dataEpoch: personalAttempt.attempt.dataEpoch,
            },
          } : {}),
        },
        ...(personalAttempt ? { onTerminal } : {}),
        onFinish: releaseProviderRequest,
        responseFormat: chatResponseFormat,
        validateChatResponse: scoped !== undefined
          && options.protocol === "openai.chat-completions.v1",
        validateTranscriptionResponse: options.protocol === "openai.audio-transcriptions.v1",
        validateSpeechResponse: options.protocol === "openai.audio-speech.v1"
          && options.bodyMode !== "none",
        validateVoiceCatalogResponse: options.protocol === "openai.audio-speech.v1"
          && options.bodyMode === "none",
        ...(scoped ? { expectedModel: scoped.provider.publicModel } : {}),
        ...(embeddingRequest && runtime.embedding
          ? { validateEmbeddingResponse: { request: embeddingRequest, space: runtime.embedding } }
          : {}),
        ...(systemOneRequest ? { validateSystemOneResponse: { request: systemOneRequest } } : {}),
        revalidate: () => {
          if (providerToken && agentConnections) {
            try {
              const latest = agentConnections.verifyProviderToken(providerToken);
              if (
                latest.record.allocationId !== allocationId
                || latest.provider.capability !== selected.binding.capability
                || latest.provider.protocol !== options.protocol
              ) {
                return {
                  ok: false as const,
                  status: 403,
                  body: errorBody("connection_forbidden", "provider token scope changed"),
                };
              }
            } catch {
              return {
                ok: false as const,
                status: 401,
                body: errorBody("unauthorized", "provider bearer token is no longer valid"),
              };
            }
          }
          const current = deps.control.resolveAllocation(allocationId, selected.binding.capability);
          if (current.status !== 200 || !("endpoint" in current.body)) {
            return { ok: false, status: current.status, body: current.body };
          }
          return { ok: true, binding: current.body };
        },
      });
    } catch (error) {
      releaseProviderRequest();
      throw error;
    }
  };
}
