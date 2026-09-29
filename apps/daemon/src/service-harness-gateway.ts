import type { ClusterState, Registry } from "@larm/core";
import { getRuntime } from "@larm/core";
import type { Context } from "hono";
import type { MetricsRegistry, RequestTracker } from "./metrics";
import type { DaemonIdentity } from "./identity";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import type { FetchLike } from "./gateway";
import { errorBody } from "./app-http";
import { SERVICE_HARNESS_ALLOCATION_ID, SERVICE_HARNESS_ASR_RUNTIME } from "./app-auth";

export function createServiceHarnessAsrGateway(deps: {
  registry: Registry;
  getState: () => ClusterState;
  identity: DaemonIdentity;
  executionGate: ExecutionGate;
  speechMaxBodyBytes?: number;
  gatewayTimeoutMs?: number;
  gatewayFetch?: FetchLike;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: { name: string; labels?: Record<string, string>; value?: number }) => void;
}) {
  const binding = () => {
    const runtime = getRuntime(deps.registry, SERVICE_HARNESS_ASR_RUNTIME);
    if (
      !runtime
      || runtime.protocol !== "openai.audio-transcriptions.v1"
      || !runtime.capability.includes("speech.stt")
    ) {
      return undefined;
    }
    const snapshot = deps.getState().runtimes.find((candidate) => candidate.id === runtime.id);
    if (!snapshot || (snapshot.status !== "HOT" && snapshot.status !== "BUSY")) return undefined;
    return {
      runtime,
      binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id },
    };
  };

  const isReady = () => binding() !== undefined;
  const handleTranscription = async (c: Context): Promise<Response> => {
    const selected = binding();
    if (!selected) return c.json(errorBody("asr_unavailable", "ASR service is not ready"), 503);
    return await proxyGateway({
      request: c.req.raw,
      allocationId: SERVICE_HARNESS_ALLOCATION_ID,
      protocol: "openai.audio-transcriptions.v1",
      upstreamPath: "/v1/audio/transcriptions",
      runtime: selected.runtime,
      bodyMode: "stream",
      maxBodyBytes: deps.speechMaxBodyBytes ?? 257 * 1024 * 1024,
      timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
      bootEpoch: deps.identity.bootEpoch,
      executionGate: deps.executionGate,
      fetchImpl: deps.gatewayFetch,
      metrics: deps.metrics,
      requestTracker: deps.requestTracker,
      now: deps.now,
      random: deps.random,
      onEvent: deps.onEvent,
      revalidate: () => {
        const current = binding();
        if (!current) {
          return {
            ok: false as const,
            status: 503,
            body: errorBody("asr_unavailable", "ASR service is not ready"),
          };
        }
        return { ok: true as const, binding: current.binding };
      },
    });
  };
  return { isReady, handleTranscription };
}
