import { LARM_VERSION } from "@larm/core";
import {
  createRuntimeBackend,
  LocalArtifactStore,
  LocalRuntimeReleaseStateStore,
  LinuxNodeTelemetry,
  LocalInferenceAuditStore,
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
import { loadCatalogGeneration } from "./catalog-generation";
import { MutationCoordinator } from "./mutation-coordinator";
import {
  FileInferenceAuditRecorder,
  loadInferenceAuditKey,
} from "./inference-audit";

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

const backend = createRuntimeBackend(registry.runtimes);
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
  getCatalogRevision: () => catalogGeneration.revision,
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
await observer.tick();

const appComponents = createAppComponents({
  registry,
  getState: () => observer.getState(),
  control,
  apiToken: config.apiToken,
  allowAnonymousAgentConnections: config.allowAnonymousAgentConnections,
  serviceHarnessAuthEnabled: config.serviceHarnessAuthEnabled,
  managementToken: config.managementToken,
  artifactManager,
  runtimeReleaseManager,
  metrics,
  requestTracker,
  controlMaxBodyBytes: config.controlMaxBodyBytes,
  gatewayMaxBodyBytes: config.gatewayMaxBodyBytes,
  speechMaxBodyBytes: config.speechMaxBodyBytes,
  gatewayTimeoutMs: config.gatewayTimeoutMs,
  stateMaxAgeMs: config.stateMaxAgeMs,
  onEvent: writeEvent,
  identity,
  executionGate,
  idempotencyTtlMs: config.idempotencyTtlMs,
  idempotencyLimit: config.idempotencyLimit,
  agentConnectionCatalog: catalogGeneration.agentConnections,
  connectionSigningKey: config.connectionSigningKey,
  connectionReadyTimeoutMs: config.connectionReadyTimeoutMs,
  providerProbeTimeoutMs: config.providerProbeTimeoutMs,
  connectionPollIntervalMs: config.pollIntervalMs,
  connectionHistoryLimit: config.historyLimit,
  inferenceAuditMode: config.inferenceAuditMode,
  inferenceAuditRecorder,
  getReleaseConvergenceStatus: async () => await Bun.file(
    process.env.LARM_RELEASE_CONVERGENCE_STATUS ?? "/var/lib/larm/release-controller/status.json",
  ).json(),
});
const { app } = appComponents;

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

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  ...(config.tlsCertFile && config.tlsKeyFile
    ? { tls: { cert: Bun.file(config.tlsCertFile), key: Bun.file(config.tlsKeyFile) } }
    : {}),
  fetch: app.fetch,
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
  clearInterval(interval);
  clearTimeout(reconciliationTimer);
  const deadline = Date.now() + config.shutdownTimeoutMs;
  const operationsDrained = await Promise.race([
    Promise.all([
      control.flush(),
      artifactManager.flush(),
      mutationCoordinator.drain(config.shutdownTimeoutMs),
      reconciliationInFlight ?? Promise.resolve(),
    ]).then(([, , mutationDrained]) => mutationDrained),
    Bun.sleep(config.shutdownTimeoutMs).then(() => false),
  ]);
  const requestsDrained = await requestTracker.drain(Math.max(0, deadline - Date.now()));
  if (!operationsDrained || !requestsDrained) {
    console.warn(`shutdown drain exceeded ${config.shutdownTimeoutMs} ms`);
  }
  server.stop(true);
  process.exit(operationsDrained && requestsDrained ? 0 : 1);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
