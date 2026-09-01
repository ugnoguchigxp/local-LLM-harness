import { createHash } from "node:crypto";
import {
  createSaaaStreamAdvertisement,
  LARM_VERSION,
  saaaStreamRequestMatchesAdvertisement,
  SAAA_LLM_STREAM_LIMITS,
  SAAA_LLM_STREAM_PROTOCOL,
} from "@larm/core";
import {
  createRuntimeBackend,
  LocalArtifactStore,
  LocalRuntimeReleaseStateStore,
  LinuxNodeTelemetry,
  LocalInferenceAuditStore,
  SwappableRuntimeBackend,
  NativeWebSocketLlmStreamBackend,
} from "@larm/backends";
import { createAppComponents } from "./app";
import { ArtifactManager } from "./artifact-manager";
import { parseDaemonConfig } from "./config";
import { ControlPlane, type ControlEvent } from "./controller";
import { MetricsRegistry, RequestTracker } from "./metrics";
import { Observer } from "./observer";
import { createBootEpoch, loadReleaseCommit } from "./identity";
import { ExecutionGate } from "./execution-gate";
import { RuntimeReleaseManager } from "./runtime-release-manager";
import { CatalogManager, loadCatalogGeneration } from "./catalog-manager";
import { MutationCoordinator } from "./mutation-coordinator";
import {
  FileInferenceAuditRecorder,
  loadInferenceAuditKey,
} from "./inference-audit";
import {
  LlmStreamServer,
  LlmStreamCapacityError,
  type LlmStreamConnection,
} from "./llm-stream-session";

const config = parseDaemonConfig();
const catalogGeneration = loadCatalogGeneration({
  configDir: config.configDir,
  artifactManifestPath: config.artifactManifestPath,
  releaseCatalogPath: config.releaseCatalogPath,
});
const { registry, artifacts, releases: runtimeReleases } = catalogGeneration;
const identity = {
  version: LARM_VERSION,
  releaseCommit: loadReleaseCommit(process.env.LARM_RELEASE_MANIFEST),
  configRevision: catalogGeneration.revision,
  bootEpoch: createBootEpoch(),
};

const backend = new SwappableRuntimeBackend(createRuntimeBackend(registry.runtimes));
const nativeLlmBackends = new Map<string, {
  configuration: string;
  backend: NativeWebSocketLlmStreamBackend;
}>();
const nativeLlmBackendFor = (runtime: (typeof registry.runtimes)[number]) => {
  if (!runtime.streaming) {
    nativeLlmBackends.delete(runtime.id);
    return undefined;
  }
  const requiredConcurrentRuns = Math.min(
    runtime.streaming.maxConcurrentRuns,
    runtime.streaming.maxConnections,
    runtime.resources.maxConcurrentRequests,
  );
  const configuration = JSON.stringify({
    streaming: runtime.streaming,
    requiredConcurrentRuns,
  });
  const existing = nativeLlmBackends.get(runtime.id);
  if (existing?.configuration === configuration) return existing.backend;
  const streamBackend = new NativeWebSocketLlmStreamBackend(runtime.id, {
    url: runtime.streaming.upstreamUrl,
    protocol: runtime.streaming.upstreamProtocol,
    connectTimeoutMs: config.nativeStreamConnectTimeoutMs,
    requiredConcurrentRuns,
  });
  nativeLlmBackends.set(runtime.id, { configuration, backend: streamBackend });
  return streamBackend;
};
const metrics = new MetricsRegistry();
const observer = new Observer(registry, backend, {
  graceMs: config.graceMs,
  telemetry: new LinuxNodeTelemetry(),
  onTelemetry: (telemetry) => {
    if (telemetry?.status !== "available") return;
    metrics.setGauge(
      "system_memory_available_bytes",
      {},
      telemetry.systemMemoryAvailableBytes ?? 0,
    );
    if (telemetry.acceleratorMemoryAvailableBytes !== undefined) {
      metrics.setGauge(
        "accelerator_memory_available_bytes",
        {},
        telemetry.acceleratorMemoryAvailableBytes,
      );
    }
  },
});
const requestTracker = new RequestTracker();
const mutationCoordinator = new MutationCoordinator();
let control: ControlPlane;
const writeEvent = (event: ControlEvent) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: event.name,
    ...event.labels,
    ...(event.value === undefined ? {} : { value: event.value }),
  }));
};
let inferenceAuditStore: LocalInferenceAuditStore | undefined;
let inferenceAuditRecorder: FileInferenceAuditRecorder | undefined;
if (config.inferenceAuditMode === "full-required") {
  const key = await loadInferenceAuditKey(config.inferenceAuditKeyFile);
  inferenceAuditStore = new LocalInferenceAuditStore({
    root: config.inferenceAuditRoot,
    key,
    retentionMs: config.inferenceAuditRetentionMs,
    maxBytes: config.inferenceAuditMaxBytes,
    minFreeBytes: config.inferenceAuditMinFreeBytes,
    maxResponseBytes: config.inferenceAuditMaxResponseBytes,
  });
  key.fill(0);
  await inferenceAuditStore.initialize();
  const initialPrune = await inferenceAuditStore.prune();
  writeEvent({
    name: "inference_audit_pruned",
    labels: {
      expired: String(initialPrune.expired),
      capacity: String(initialPrune.capacity),
      interrupted: String(initialPrune.interrupted),
    },
  });
  inferenceAuditRecorder = new FileInferenceAuditRecorder({
    store: inferenceAuditStore,
    materializationTimeoutMs: config.inferenceAuditMaterializationTimeoutMs,
  });
}
const observeEvent = (event: ControlEvent) => {
  metrics.record(event);
  if (event.name.startsWith("allocation_")) {
    metrics.setGauge(
      "active_allocations",
      {},
      control?.getActiveAllocationCount() ?? 0,
    );
  }
  writeEvent(event);
};
const executionGate = new ExecutionGate({
  onEvent: observeEvent,
  onState: (runtime, state) => {
    metrics.setGauge("execution_active", { runtime }, state.active);
    metrics.setGauge("execution_queued", { runtime }, state.queued);
  },
});
const artifactStore = new LocalArtifactStore({
  stagingRoot: config.artifactStagingRoot,
  rollbackRoot: config.artifactRollbackRoot,
  stateRoot: config.artifactStateRoot,
});
let artifactManager: ArtifactManager;
let runtimeReleaseManager: RuntimeReleaseManager;
let catalogManager: CatalogManager;
control = new ControlPlane(registry, backend, observer, {
  bootEpoch: identity.bootEpoch,
  idleTtlMs: config.idleTtlMs,
  startupTimeoutMs: config.startupTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
  historyLimit: config.historyLimit,
  maxActiveAllocations: config.activeAllocationLimit,
  stateMaxAgeMs: config.stateMaxAgeMs,
  requireFreshTelemetry: true,
  telemetryMaxAgeMs: config.telemetryMaxAgeMs,
  getCatalogRevision: () => catalogManager?.revision ?? catalogGeneration.revision,
  getRuntimeRelease: (runtimeId) => runtimeReleaseManager?.getActiveRelease(runtimeId),
  isRuntimeMutating: (runtimeId) => artifactManager?.isRuntimeMutating(runtimeId) ?? false,
  onEvent: observeEvent,
  deploymentCoordinator: {
    ensureRuntime: (runtimeId, allocationId, onPhase, signal) =>
      artifactManager.ensureRuntime(runtimeId, allocationId, onPhase, signal),
  },
});
metrics.setGauge("active_allocations", {}, 0);
artifactManager = new ArtifactManager(
  artifacts,
  registry,
  artifactStore,
  backend,
  observer,
  {
    activeAllocations: () => control.getAllocations(),
    isRuntimeTransitioning: (runtimeId) => control.isRuntimeTransitioning(runtimeId),
    historyLimit: config.historyLimit,
    maxPendingOperations: config.artifactOperationLimit,
    runtimeArtifacts: (runtimeId) => runtimeReleaseManager?.getRuntimeArtifacts(runtimeId),
    additionalArtifactOwners: runtimeReleases.map((release) => ({
      runtimeId: release.runtime,
      artifactIds: release.artifacts,
    })),
    onEvent: observeEvent,
    mutationCoordinator,
    onOperationState: (active) => metrics.setGauge("artifact_operations_active", {}, active),
  },
);
await artifactManager.initialize();
runtimeReleaseManager = new RuntimeReleaseManager(
  runtimeReleases,
  artifactManager,
  new LocalRuntimeReleaseStateStore(config.artifactStateRoot),
  Date.now,
  (runtimeId) => observer.getState().runtimes.find((runtime) => runtime.id === runtimeId),
);
await runtimeReleaseManager.initialize();
catalogManager = new CatalogManager(
  catalogGeneration,
  {
    configDir: config.configDir,
    artifactManifestPath: config.artifactManifestPath,
    releaseCatalogPath: config.releaseCatalogPath,
  },
  control,
  observer,
  backend,
  artifactManager,
  runtimeReleaseManager,
  executionGate,
  { onEvent: observeEvent, mutationCoordinator },
);

await observer.tick();

const appComponents = createAppComponents({
  registry,
  getRegistry: () => catalogManager.registry,
  getState: () => observer.getState(),
  control,
  apiToken: config.apiToken,
  allowAnonymousAgentConnections: config.allowAnonymousAgentConnections,
  managementToken: config.managementToken,
  artifactManager,
  runtimeReleaseManager,
  catalogManager,
  metrics,
  requestTracker,
  controlMaxBodyBytes: config.controlMaxBodyBytes,
  gatewayMaxBodyBytes: config.gatewayMaxBodyBytes,
  speechMaxBodyBytes: config.speechMaxBodyBytes,
  gatewayTimeoutMs: config.gatewayTimeoutMs,
  stateMaxAgeMs: config.stateMaxAgeMs,
  onEvent: writeEvent,
  identity,
  getConfigRevision: () => catalogManager.revision,
  executionGate,
  idempotencyTtlMs: config.idempotencyTtlMs,
  idempotencyLimit: config.idempotencyLimit,
  agentConnectionCatalog: catalogGeneration.agentConnections,
  getAgentConnectionCatalog: () => catalogManager.generation.agentConnections,
  connectionSigningKey: config.connectionSigningKey,
  connectionReadyTimeoutMs: config.connectionReadyTimeoutMs,
  providerProbeTimeoutMs: config.providerProbeTimeoutMs,
  connectionPollIntervalMs: config.pollIntervalMs,
  connectionHistoryLimit: config.historyLimit,
  inferenceAuditMode: config.inferenceAuditMode,
  inferenceAuditRecorder,
  resolveStreaming: async ({ allocationId, provider, audienceBaseUrl, audienceNetwork }) => {
    const resolved = control.resolveAllocation(allocationId, provider.capability);
    if (resolved.status !== 200 || !("runtime" in resolved.body)) return undefined;
    const runtime = catalogManager.registry.runtimes.find((candidate) => candidate.id === resolved.body.runtime);
    if (!runtime?.streaming) return undefined;
    const streamBackend = nativeLlmBackendFor(runtime);
    if (!streamBackend || !await streamBackend.ready()) return undefined;
    const capacity = Math.min(
      runtime.streaming.maxConcurrentRuns,
      runtime.streaming.maxConnections,
      runtime.resources.maxConcurrentRequests,
    );
    try {
      return createSaaaStreamAdvertisement({
        baseUrl: audienceBaseUrl,
        maxConcurrentRuns: capacity,
        maxConnections: capacity,
        resumeWindowMs: runtime.streaming.resumeWindowMs,
        allowInsecureNonLoopback: audienceNetwork !== "tls",
      });
    } catch {
      return undefined;
    }
  },
});
const { app, agentConnections } = appComponents;
const llmStreamServer = new LlmStreamServer({
  onEvent: (event) => {
    metrics.record(event);
    writeEvent(event);
  },
});

let ticking = false;
const interval = setInterval(() => {
  if (ticking) {
    return;
  }
  ticking = true;
  void observer
    .tick()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`observe failed: ${message}`);
    })
    .finally(() => {
      ticking = false;
    });
}, config.observeIntervalMs);

let auditPruneInFlight: Promise<void> | undefined;
const auditPruneInterval = inferenceAuditStore
  ? setInterval(() => {
    if (auditPruneInFlight || !inferenceAuditStore) return;
    auditPruneInFlight = inferenceAuditStore.prune().then((result) => {
      writeEvent({
        name: "inference_audit_pruned",
        labels: {
          expired: String(result.expired),
          capacity: String(result.capacity),
          interrupted: String(result.interrupted),
        },
      });
    }).catch(() => {
      writeEvent({ name: "inference_audit_prune_failed", labels: {} });
    }).finally(() => {
      auditPruneInFlight = undefined;
    });
  }, 60 * 60 * 1_000)
  : undefined;
auditPruneInterval?.unref?.();

const server = Bun.serve<LlmStreamConnection>({
  port: config.port,
  hostname: config.hostname,
  ...(config.tlsCertFile && config.tlsKeyFile
    ? { tls: { cert: Bun.file(config.tlsCertFile), key: Bun.file(config.tlsKeyFile) } }
    : {}),
  fetch: async (request, bunServer) => {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/llm/stream") return await app.fetch(request);
    if (request.method !== "GET") {
      return Response.json({ error: { code: "method_not_allowed", message: "WebSocket upgrade requires GET" } }, {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    if (url.search || url.hash) {
      return Response.json({ error: { code: "invalid_request", message: "stream URL cannot use query or fragment" } }, {
        status: 400,
      });
    }
    if (control.isDraining()) {
      return Response.json({ error: { code: "draining", message: "control plane is draining" } }, { status: 503 });
    }
    if (!agentConnections) {
      return Response.json({
        error: { code: "connection_credentials_unavailable", message: "stream authentication is unavailable" },
      }, { status: 503 });
    }
    if (request.headers.get("sec-websocket-protocol")?.trim() !== SAAA_LLM_STREAM_PROTOCOL) {
      return Response.json({
        error: { code: "unsupported_protocol", message: `Sec-WebSocket-Protocol must equal ${SAAA_LLM_STREAM_PROTOCOL}` },
      }, { status: 400 });
    }
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer larm_conn_v1.") ? authorization.slice(7) : undefined;
    if (!token) {
      return Response.json({ error: { code: "unauthorized", message: "valid provider bearer token required" } }, {
        status: 401,
      });
    }
    let verified;
    try {
      verified = agentConnections.verifyProviderToken(token);
    } catch {
      return Response.json({ error: { code: "unauthorized", message: "provider bearer token is invalid" } }, {
        status: 401,
      });
    }
    if (verified.provider.protocol !== "openai.chat-completions.v1") {
      return Response.json({ error: { code: "connection_forbidden", message: "provider token is not for LLM" } }, {
        status: 403,
      });
    }
    const resolved = control.resolveAllocation(verified.record.allocationId, verified.provider.capability);
    if (resolved.status !== 200 || !("runtime" in resolved.body)) {
      return Response.json(resolved.body, { status: resolved.status });
    }
    const runtime = catalogManager.registry.runtimes.find((candidate) => candidate.id === resolved.body.runtime);
    const streamBackend = runtime ? nativeLlmBackendFor(runtime) : undefined;
    if (!runtime?.streaming || !streamBackend) {
      return Response.json({
        error: { code: "native_stream_unavailable", message: "native LLM stream is not ready" },
      }, { status: 503 });
    }
    let streaming;
    try {
      const capacity = Math.min(
        runtime.streaming.maxConcurrentRuns,
        runtime.streaming.maxConnections,
        runtime.resources.maxConcurrentRequests,
      );
      streaming = createSaaaStreamAdvertisement({
        baseUrl: verified.record.audience.baseUrl,
        maxConcurrentRuns: capacity,
        maxConnections: capacity,
        resumeWindowMs: runtime.streaming.resumeWindowMs,
        allowInsecureNonLoopback: verified.record.audience.network !== "tls",
      });
    } catch {
      return Response.json({ error: { code: "tls_required", message: "non-loopback LLM streaming requires WSS" } }, {
        status: 426,
      });
    }
    if (!saaaStreamRequestMatchesAdvertisement(request.url, streaming)) {
      return Response.json({
        error: { code: "connection_origin_mismatch", message: "stream request does not match the claimed audience URL" },
      }, { status: 403 });
    }
    const validate = () => {
      try {
        const latest = agentConnections.verifyProviderToken(token);
        if (
          latest.record.id !== verified.record.id
          || latest.record.allocationId !== verified.record.allocationId
          || latest.provider.name !== verified.provider.name
          || latest.provider.capability !== verified.provider.capability
        ) return false;
      } catch {
        return false;
      }
      const current = control.resolveAllocation(verified.record.allocationId, verified.provider.capability);
      return current.status === 200
        && "runtime" in current.body
        && current.body.runtime === runtime.id;
    };
    if (!validate()) {
      return Response.json({ error: { code: "unauthorized", message: "provider bearer token expired" } }, {
        status: 401,
      });
    }
    if (!await streamBackend.ready()) {
      return Response.json({
        error: { code: "native_stream_unavailable", message: "native LLM stream is not ready" },
      }, { status: 503 });
    }
    if (!validate()) {
      return Response.json({ error: { code: "unauthorized", message: "provider bearer token expired" } }, {
        status: 401,
      });
    }
    let connection: LlmStreamConnection;
    try {
      connection = llmStreamServer.createConnection({
        connectionScope: `${verified.record.id}:${verified.provider.name}`,
        allocationId: verified.record.allocationId,
        providerName: verified.provider.name,
        capability: verified.provider.capability,
        publicModel: verified.provider.publicModel,
        runtimeId: runtime.id,
        credentialFingerprint: createHash("sha256").update(token).digest("hex"),
        streaming,
        backend: streamBackend,
        validate,
        lifecycleSignal: control.getAllocationSignal(verified.record.allocationId),
      });
    } catch (error) {
      if (error instanceof LlmStreamCapacityError) {
        return Response.json({ error: { code: "capacity", message: error.message } }, { status: 429 });
      }
      throw error;
    }
    let upgraded = false;
    try {
      upgraded = bunServer.upgrade(request, {
        data: connection,
        headers: { "Sec-WebSocket-Protocol": SAAA_LLM_STREAM_PROTOCOL },
      });
    } catch (error) {
      llmStreamServer.close(connection);
      throw error;
    }
    if (!upgraded) {
      llmStreamServer.close(connection);
      return Response.json({ error: { code: "upgrade_failed", message: "WebSocket upgrade failed" } }, {
        status: 400,
      });
    }
    return undefined;
  },
  websocket: {
    maxPayloadLength: SAAA_LLM_STREAM_LIMITS.maxClientControlBytes,
    perMessageDeflate: false,
    open: (socket) => llmStreamServer.open(socket.data, socket),
    message: (socket, message) => llmStreamServer.message(
      socket.data,
      typeof message === "string" ? message : new Uint8Array(message),
    ),
    drain: (socket) => llmStreamServer.drain(socket.data),
    pong: (socket) => llmStreamServer.pong(socket.data),
    close: (socket) => llmStreamServer.close(socket.data),
  },
});

console.log(`larm listening on ${config.tlsCertFile ? "https" : "http"}://${server.hostname}:${server.port}`);
console.log(`config ${config.configDir}`);

let reconciliationInFlight: Promise<void> | undefined;
const reconciliationTimer = setTimeout(() => {
  const task = control.reconcileOrphanedPreferred()
    .then(() => undefined)
    .catch((error) => {
      console.error(`startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  reconciliationInFlight = task;
  void task.finally(() => {
    if (reconciliationInFlight === task) {
      reconciliationInFlight = undefined;
    }
  });
}, config.recoveryGraceMs);
reconciliationTimer.unref?.();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`received ${signal}; draining`);
  control.beginDrain();
  mutationCoordinator.beginDrain();
  artifactManager.beginDrain();
  executionGate.beginDrain();
  llmStreamServer.beginDrain();
  clearInterval(interval);
  if (auditPruneInterval) clearInterval(auditPruneInterval);
  clearTimeout(reconciliationTimer);
  const deadline = Date.now() + config.shutdownTimeoutMs;
  const operationsDrained = await Promise.race([
    Promise.all([
      control.flush(),
      artifactManager.flush(),
      mutationCoordinator.drain(config.shutdownTimeoutMs),
      llmStreamServer.shutdown(config.shutdownTimeoutMs),
      reconciliationInFlight ?? Promise.resolve(),
      auditPruneInFlight ?? Promise.resolve(),
    ]).then(([, , mutationDrained, streamDrained]) => mutationDrained && streamDrained),
    Bun.sleep(config.shutdownTimeoutMs).then(() => false),
  ]);
  if (!operationsDrained) await llmStreamServer.shutdown(0);
  const requestsDrained = await requestTracker.drain(Math.max(0, deadline - Date.now()));
  if (!operationsDrained || !requestsDrained) {
    console.warn(`shutdown drain exceeded ${config.shutdownTimeoutMs} ms`);
  }
  server.stop(true);
  process.exit(operationsDrained && requestsDrained ? 0 : 1);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
