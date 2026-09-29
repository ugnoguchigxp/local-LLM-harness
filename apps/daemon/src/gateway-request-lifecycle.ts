import type { RuntimeProtocol } from "@larm/core";
import type { AgentConnectionController, VerifiedProviderToken } from "./agent-connection-controller";
import type { ControlPlane } from "./controller";

type ConnectionRequestTracker = Pick<AgentConnectionController, "beginProviderRequest" | "finishProviderRequest">;
type ProviderRequestReferences = Pick<ControlPlane, "retainProviderRequest" | "releaseProviderRequest">;

export type GatewayProviderRequest =
  | { ok: false; code: "connection_idle_released" | "connection_inactive" }
  | { ok: true; requestId: string; providerInstanceId?: string; release: () => void };

export function beginGatewayProviderRequest(input: {
  allocationId: string;
  capability: string;
  protocol: RuntimeProtocol;
  bodyMode: "buffered" | "stream" | "none";
  scoped?: VerifiedProviderToken;
  connections?: ConnectionRequestTracker;
  control: ProviderRequestReferences;
  random?: () => string;
}): GatewayProviderRequest {
  const requestId = `provider-request-${input.random?.() ?? crypto.randomUUID()}`;
  const connectionRequestTracked = input.scoped
    ? input.connections?.beginProviderRequest(
      input.scoped.record.id,
      requestId,
      input.protocol,
      !(input.protocol === "openai.audio-speech.v1" && input.bodyMode === "none"),
    ) === true
    : false;
  if (input.scoped && !connectionRequestTracked) {
    return {
      ok: false,
      code: input.scoped.record.error?.code === "foreground_idle_timeout"
        ? "connection_idle_released"
        : "connection_inactive",
    };
  }

  const providerInstanceId = input.control.retainProviderRequest?.(
    input.allocationId,
    input.capability,
    requestId,
  );
  let released = false;
  return {
    ok: true,
    requestId,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    release: () => {
      if (released) return;
      released = true;
      input.control.releaseProviderRequest?.(providerInstanceId, requestId);
      if (connectionRequestTracked && input.scoped) {
        input.connections?.finishProviderRequest(input.scoped.record.id, requestId);
      }
    },
  };
}
