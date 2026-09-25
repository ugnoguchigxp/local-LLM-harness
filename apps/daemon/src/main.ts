import { LARM_VERSION } from "@larm/core";
import {
  createRuntimeBackend,
  LocalArtifactStore,
  LocalRuntimeReleaseStateStore,
  LinuxNodeTelemetry,
  LocalInferenceAuditStore,
  LocalContextMetadataStore,
  LocalContextSourceStore,
  LlamaContextTokenizer,
  LlamaContextSlotEraseAdapter,
  LocalPersonalStateJournal,
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
import { ContextController } from "./context-controller";
import { PersonalStateController } from "./personal-state-controller";
import { GatewayLifecycle, type GatewayLifecycleState } from "./gateway-lifecycle";
import { verifyGatewayStartup } from "./gateway-startup";
import { AceStepMusicProvider, MusicGenerationManager } from "./music-manager";
import { ImageArtifactManager } from "./image-artifact-manager";

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
const gatewayStates: GatewayLifecycleState[] = ["starting", "verifying", "ready", "draining", "failed"];
const gatewayLifecycle = new GatewayLifecycle({
  bootEpoch: identity.bootEpoch,
  configRevision: identity.configRevision,
  onTransition: (transition) => {
    for (const state of gatewayStates) {
      metrics.setGauge("gateway_readiness", { state }, transition.to === state ? 1 : 0);
    }
    writeEvent({
      name: "gateway_readiness_transition",
      labels: {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
        bootEpoch: transition.bootEpoch,
        configRevision: transition.configRevision,
        ...(transition.listener ? { listener: transition.listener } : {}),
      },
    });
  },
});
metrics.setGauge("gateway_readiness", { state: "starting" }, 1);
writeEvent({
  name: "daemon_starting",
  labels: {
    bootEpoch: identity.bootEpoch,
    configRevision: identity.configRevision,
    releaseCommit: identity.releaseCommit,
  },
});
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
  getRuntimeReleaseDefinition: (runtimeId) => {
    const active = runtimeReleaseManager?.getActiveRelease(runtimeId);
    return active ? runtimeReleases.find((release) => release.id === active) : undefined;
  },
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

const contextSourceStore = new LocalContextSourceStore(config.contextSourceRoot);
const contextTokenizer = new LlamaContextTokenizer();
const contextController = new ContextController({
  enabled: config.contextEnabled,
  registry,
  releases: runtimeReleases,
  metadataStore: new LocalContextMetadataStore(config.contextMetadataRoot),
  sourceProvider: contextSourceStore,
  tokenizer: contextTokenizer,
  getState: () => observer.getState(),
  getAllocation: (id) => control.getAllocation(id),
  getActiveRelease: (runtime) => runtimeReleaseManager.getActiveRelease(runtime),
  isDraining: () => control.isDraining(),
  stateMaxAgeMs: config.stateMaxAgeMs,
  sourceMaxBytes: config.contextSourceMaxBytes,
  sourceMaxTotalBytes: config.contextSourceMaxTotalBytes,
  materializedMaxBytes: config.contextMaterializedMaxBytes,
  idempotencyTtlMs: config.idempotencyTtlMs,
  idempotencyLimit: config.idempotencyLimit,
  onEvent: observeEvent,
});
const updateContextMetrics = async () => {
  const statuses = contextController.statuses().runtimes;
  const states = [
    "DISABLED",
    "INELIGIBLE",
    "STANDBY",
    "STARTING",
    "ACTIVE",
    "BUSY",
    "DRAINING",
    "DEGRADED",
  ] as const;
  for (const status of statuses) {
    for (const state of states) {
      metrics.setGauge(
        "context_activation_state",
        { runtime: status.runtime, release: status.release ?? "none", state },
        status.state === state ? 1 : 0,
      );
    }
  }
  metrics.setGauge(
    "context_active_runtimes",
    {},
    statuses.filter((status) => status.state === "ACTIVE" || status.state === "BUSY").length,
  );
};
if (config.contextEnabled) {
  await contextController.initialize();
  await contextController.refreshRuntimeProbes();
  await updateContextMetrics();
}

const personalStateController = new PersonalStateController({
  enabled: config.personalStateEnabled,
  journal: new LocalPersonalStateJournal(config.personalStateJournalRoot),
  context: contextController,
  sourceStore: contextSourceStore,
  tokenizer: contextTokenizer,
  auditStore: inferenceAuditStore,
  slotAdapter: new LlamaContextSlotEraseAdapter(),
  sourceMaxBytes: config.contextSourceMaxBytes,
  sourceMaxTotalBytes: config.contextSourceMaxTotalBytes,
  receiptTtlMs: config.personalStateReceiptTtlMs,
  quarantineRuntime: (runtime) => executionGate.quarantineRuntime(runtime),
  clearRuntimeQuarantine: (runtime) => executionGate.clearRuntimeQuarantine(runtime),
});
await personalStateController.initialize();

const startupProbeToken = crypto.randomUUID();
const musicManager = config.musicProviderEndpoint
  ? new MusicGenerationManager(new AceStepMusicProvider({
    endpoint: config.musicProviderEndpoint,
    apiKey: config.musicProviderApiKey,
    pollIntervalMs: config.musicPollIntervalMs,
    maxAudioBytes: config.musicMaxAudioBytes,
    upstreamOutputRoot: config.musicUpstreamOutputRoot,
  }), {
    artifactRoot: config.musicArtifactRoot,
    concurrency: 1,
    retentionMs: config.musicArtifactRetentionMs,
    wavRetentionMs: config.musicWavRetentionMs,
    maxArtifactBytes: config.musicArtifactMaxBytes,
    favoriteMaxArtifactBytes: config.musicFavoriteMaxBytes,
    pruneIntervalMs: config.musicPruneIntervalMs,
  })
  : undefined;
await musicManager?.initialize();
const imageArtifactManager = new ImageArtifactManager(config.imageArtifactRoot, {
  maxBytes: config.imageArtifactMaxBytes,
  targetBytes: config.imageArtifactTargetBytes,
  pruneIntervalMs: config.imagePruneIntervalMs,
});
await imageArtifactManager.initialize();
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
  embeddingMaxBodyBytes: config.embeddingMaxBodyBytes,
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
  contextController,
  personalStateController,
  personalStateMaxSourceBytes: config.contextSourceMaxBytes,
  getGatewayReadiness: () => gatewayLifecycle.snapshot(),
  startupProbeToken,
  musicManager,
  imageArtifactManager,
  getReleaseConvergenceStatus: async () => await Bun.file(
    process.env.LARM_RELEASE_CONVERGENCE_STATUS ?? "/var/lib/larm/release-controller/status.json",
  ).json(),
});
const { app, modelBroker } = appComponents;

const notifySystemd = async (...args: string[]): Promise<void> => {
  if (!process.env.NOTIFY_SOCKET) return;
  const child = Bun.spawn([
    "/usr/bin/systemd-notify",
    `--pid=${process.pid}`,
    ...args,
  ], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`systemd readiness notification failed: ${stderr.trim() || `exit ${code}`}`);
  }
};

await control.reconcileProviderInstances();

let ticking = false;
const interval = setInterval(() => {
  if (ticking) {
    return;
  }
  ticking = true;
  void observer
    .tick()
    .then(async () => await contextController.refreshRuntimeProbes())
    .then(async () => await updateContextMetrics())
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`observe failed: ${message}`);
    })
    .finally(() => {
      ticking = false;
    });
}, config.observeIntervalMs);

const server = (() => {
  try {
    return Bun.serve({
      port: config.port,
      hostname: config.hostname,
      // Model activation and long-running inference own their deadlines. Bun's
      // default 10-second socket timeout would otherwise terminate cold starts
      // before ModelBroker can return a structured response.
      idleTimeout: config.httpIdleTimeoutSeconds,
      ...(config.tlsCertFile && config.tlsKeyFile
        ? { tls: { cert: Bun.file(config.tlsCertFile), key: Bun.file(config.tlsKeyFile) } }
        : {}),
      fetch: app.fetch,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gatewayLifecycle.listenerVerificationFailed("listener_bind_failed");
    writeEvent({
      name: "listener_bind_failed",
      labels: {
        bootEpoch: identity.bootEpoch,
        configRevision: identity.configRevision,
        reason,
      },
    });
    throw error;
  }
})();
const listenerUrl = `${config.tlsCertFile ? "https" : "http"}://${server.hostname}:${server.port}`;
gatewayLifecycle.listenerBound(listenerUrl);
writeEvent({
  name: "listener_bound",
  labels: {
    bootEpoch: identity.bootEpoch,
    configRevision: identity.configRevision,
    listener: listenerUrl,
  },
});
console.log(`larm listening on ${listenerUrl}`);
console.log(`config ${config.configDir}`);

try {
  if (!modelBroker) throw new Error("OpenAI-compatible model broker is not configured");
  const probeHost = config.hostname === "0.0.0.0" || config.hostname === "::"
    ? "localhost"
    : config.hostname;
  await verifyGatewayStartup({
    baseUrl: process.env.LARM_STARTUP_PROBE_BASE_URL
      ?? `${config.tlsCertFile ? "https" : "http"}://${probeHost}:${server.port}`,
    apiToken: config.apiToken,
    model: process.env.LARM_REQUIRED_CHAT_MODEL ?? "qwen-agent-worker",
    probeModel: process.env.LARM_STARTUP_PROBE_CHAT_MODEL ?? "coding-default",
    startupProbeToken,
    timeoutMs: config.connectionReadyTimeoutMs,
  });
  gatewayLifecycle.listenerVerified();
  await notifySystemd(
    "--ready",
    `--status=LARM ready; bootEpoch=${identity.bootEpoch}; configRevision=${identity.configRevision}`,
  );
  writeEvent({
    name: "listener_accept_verified",
    labels: {
      bootEpoch: identity.bootEpoch,
      configRevision: identity.configRevision,
      model: process.env.LARM_STARTUP_PROBE_CHAT_MODEL ?? "coding-default",
    },
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  gatewayLifecycle.listenerVerificationFailed("listener_verification_failed");
  writeEvent({
    name: "listener_accept_failed",
    labels: {
      bootEpoch: identity.bootEpoch,
      configRevision: identity.configRevision,
      reason,
    },
  });
  server.stop(true);
  throw error;
}

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
  gatewayLifecycle.beginDrain(signal);
  await notifySystemd("--stopping", `--status=LARM draining after ${signal}`).catch((error) => {
    console.warn(error instanceof Error ? error.message : String(error));
  });
  console.log(`received ${signal}; draining`);
  control.beginDrain();
  contextController.beginDrain();
  mutationCoordinator.beginDrain();
  artifactManager.beginDrain();
  executionGate.beginDrain();
  clearInterval(interval);
  musicManager?.close();
  imageArtifactManager.close();
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
