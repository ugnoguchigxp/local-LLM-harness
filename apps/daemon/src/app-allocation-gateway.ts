import {
  getRuntime,
  selectProtocolBinding,
  type Registry,
  type RuntimeProtocol,
} from "@larm/core";
import type { Context } from "hono";
import type { ControlPlane } from "./controller";
import type { MetricsRegistry } from "./metrics";
import type { VerifiedProviderToken } from "./agent-connection-controller";
import { errorBody, openAiErrorBody } from "./app-http";

type ProtocolBindingSelection = Extract<
  ReturnType<typeof selectProtocolBinding>,
  { ok: true }
>;

export type GatewayAllocationResolution =
  | { ok: false; response: Response }
  | {
    ok: true;
    allocationId: string;
    requestedCapability?: string;
    allocation: NonNullable<ReturnType<ControlPlane["getAllocation"]>>;
    selected: ProtocolBindingSelection;
    runtime: NonNullable<ReturnType<typeof getRuntime>>;
    release?: string;
  };

export function resolveGatewayAllocation(input: {
  context: Context;
  registry: Registry;
  control: Pick<ControlPlane, "getAllocation" | "allocationLookupError" | "resolveAllocation">;
  protocol: RuntimeProtocol;
  routeCapability?: string;
  declaredAllocationId?: string;
  scoped?: VerifiedProviderToken;
  capabilityHeader?: string;
  contextViewId?: string;
  voicevoxOnlyParameter?: string;
  metrics?: MetricsRegistry;
  onEvent?: (event: { name: string; labels: Record<string, string> }) => void;
}): GatewayAllocationResolution {
  const allocationId = input.scoped?.record.allocationId ?? input.declaredAllocationId;
  if (allocationId === undefined) {
    return {
      ok: false,
      response: input.context.json(errorBody("allocation_required", "x-larm-allocation-id is required"), 400),
    };
  }
  if (!/^alloc_[a-zA-Z0-9._-]{1,186}$/.test(allocationId)) {
    return {
      ok: false,
      response: input.context.json(errorBody("bad_request", "x-larm-allocation-id is invalid"), 400),
    };
  }
  const requestedCapability = input.scoped?.provider.capability
    ?? input.routeCapability
    ?? input.capabilityHeader;
  if (
    requestedCapability !== undefined
    && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(requestedCapability)
  ) {
    return {
      ok: false,
      response: input.context.json(errorBody("bad_request", "x-larm-capability is invalid"), 400),
    };
  }
  const allocation = input.control.getAllocation(allocationId);
  if (!allocation) {
    const missing = input.control.allocationLookupError(allocationId);
    return { ok: false, response: input.context.json(missing.body, missing.status) };
  }
  const selected = selectProtocolBinding({
    registry: input.registry,
    allocation,
    protocol: input.protocol,
    capability: requestedCapability,
  });
  if (!selected.ok) {
    const status = selected.reason === "capability_not_allocated"
      || selected.reason === "protocol_not_allocated"
      ? 404
      : 409;
    return {
      ok: false,
      response: input.context.json(
        errorBody(selected.reason, selected.reason.replaceAll("_", " ")),
        status,
      ),
    };
  }
  if (input.voicevoxOnlyParameter && selected.binding.capability !== "speech.tts") {
    return {
      ok: false,
      response: input.context.json(openAiErrorBody(
        "unsupported_parameter",
        `${input.voicevoxOnlyParameter} is not supported by the allocated TTS provider`,
        input.voicevoxOnlyParameter,
      ), 400),
    };
  }
  const resolved = input.control.resolveAllocation(allocationId, selected.binding.capability);
  if (resolved.status !== 200 || !("endpoint" in resolved.body)) {
    return {
      ok: false,
      response: input.context.json(resolved.body, resolved.status as 404 | 409 | 503),
    };
  }
  const runtime = getRuntime(input.registry, resolved.body.runtime);
  if (!runtime || runtime.protocol !== input.protocol) {
    return {
      ok: false,
      response: input.context.json(errorBody("protocol_mismatch", "allocated runtime protocol does not match"), 409),
    };
  }
  if (
    input.protocol === "openai.chat-completions.v1"
    && !input.contextViewId
    && runtime.context?.class === "managed-context"
  ) {
    const event = { name: "context_bypass", labels: { reason: "view_not_requested" } };
    input.metrics?.record(event);
    input.onEvent?.(event);
  }
  const release = selected.binding.release;
  if (input.contextViewId && !release) {
    return {
      ok: false,
      response: input.context.json(errorBody("context_view_stale", "allocated runtime has no release binding"), 409),
    };
  }
  return {
    ok: true,
    allocationId,
    ...(requestedCapability ? { requestedCapability } : {}),
    allocation,
    selected,
    runtime,
    ...(release ? { release } : {}),
  };
}
