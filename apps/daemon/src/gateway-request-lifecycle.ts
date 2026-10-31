import type { RuntimeProtocol } from "@larm/core";
import type { AgentConnectionController, VerifiedProviderToken } from "./agent-connection-controller";
import type { ControlPlane } from "./controller";
import { ProviderRequestAdmissionError } from "./provider-request-admission";

type ConnectionRequestTracker = Pick<AgentConnectionController, "beginProviderRequest" | "finishProviderRequest">;
type ProviderRequestReferences = Pick<ControlPlane, "retainProviderRequest" | "releaseProviderRequest">;

export type GatewayProviderRequest =
  | { ok: false; code: "connection_idle_released" | "connection_inactive" | "foreground_active" | "foreground_preemption_failed" | "provider_draining" }
  | { ok: true; requestId: string; providerInstanceId?: string; release: () => void };

export async function beginGatewayProviderRequest(input: {
  allocationId: string;
  capability: string;
  protocol: RuntimeProtocol;
  bodyMode: "buffered" | "stream" | "none";
  scoped?: VerifiedProviderToken;
  connections?: ConnectionRequestTracker;
  control: ProviderRequestReferences;
  random?: () => string;
}): Promise<GatewayProviderRequest> {
  const requestId = `provider-request-${input.random?.() ?? crypto.randomUUID()}`;
  const admission = input.scoped
    ? await input.connections?.beginProviderRequest(
      input.scoped.record.id,
      requestId,
      input.protocol,
      !(input.protocol === "openai.audio-speech.v1" && input.bodyMode === "none"),
    )
    : undefined;
  const connectionRequestTracked = admission === "accepted";
  if (input.scoped && !connectionRequestTracked) {
    return {
      ok: false,
      code: admission === "foreground_active" || admission === "foreground_preemption_failed"
        ? admission
        : input.scoped.record.error?.code === "foreground_idle_timeout"
        ? "connection_idle_released"
        : "connection_inactive",
    };
  }

  let providerInstanceId: string | undefined;
  try {
    providerInstanceId = input.control.retainProviderRequest?.(input.allocationId, input.capability, requestId);
  } catch (error) {
    if (connectionRequestTracked && input.scoped) input.connections?.finishProviderRequest(input.scoped.record.id, requestId);
    if (error instanceof ProviderRequestAdmissionError) return { ok: false, code: error.code };
    throw error;
  }
  let released = false;
  return {
    ok: true,
    requestId,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    release: () => {
      if (released) return;
      released = true;
      try {
        input.control.releaseProviderRequest?.(providerInstanceId, requestId);
      } finally {
        if (connectionRequestTracked && input.scoped) input.connections?.finishProviderRequest(input.scoped.record.id, requestId);
      }
    },
  };
}
