import { LARM_VERSION, loadArtifactManifest, loadRegistry } from "@larm/core";
import { createRuntimeBackend, LocalArtifactStore } from "@larm/backends";
import { createApp } from "./app";
import { ArtifactManager } from "./artifact-manager";
import { parseDaemonConfig } from "./config";
import { ControlPlane, type ControlEvent } from "./controller";
import { MetricsRegistry, RequestTracker } from "./metrics";
import { Observer } from "./observer";
import { computeConfigRevision, createBootEpoch } from "./identity";
import { ExecutionGate } from "./execution-gate";

const config = parseDaemonConfig();
const identity = {
  version: LARM_VERSION,
  configRevision: computeConfigRevision(config.configDir, config.artifactManifestPath),
  bootEpoch: createBootEpoch(),
};

const registry = loadRegistry(config.configDir);
const backend = createRuntimeBackend(registry.runtimes);
const observer = new Observer(registry, backend, { graceMs: config.graceMs });
const metrics = new MetricsRegistry();
const requestTracker = new RequestTracker();
let control: ControlPlane;
const writeEvent = (event: ControlEvent) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: event.name,
    ...event.labels,
    ...(event.value === undefined ? {} : { value: event.value }),
  }));
};
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
control = new ControlPlane(registry, backend, observer, {
  bootEpoch: identity.bootEpoch,
  idleTtlMs: config.idleTtlMs,
  startupTimeoutMs: config.startupTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
  historyLimit: config.historyLimit,
  maxActiveAllocations: config.activeAllocationLimit,
  stateMaxAgeMs: config.stateMaxAgeMs,
  isRuntimeMutating: (runtimeId) => artifactManager?.isRuntimeMutating(runtimeId) ?? false,
  onEvent: observeEvent,
  deploymentCoordinator: {
    ensureRuntime: (runtimeId, allocationId, onPhase, signal) =>
      artifactManager.ensureRuntime(runtimeId, allocationId, onPhase, signal),
  },
});
metrics.setGauge("active_allocations", {}, 0);
artifactManager = new ArtifactManager(
  loadArtifactManifest(config.artifactManifestPath),
  registry,
  artifactStore,
  backend,
  observer,
  {
    activeAllocations: () => control.getAllocations(),
    isRuntimeTransitioning: (runtimeId) => control.isRuntimeTransitioning(runtimeId),
    historyLimit: config.historyLimit,
    maxPendingOperations: config.artifactOperationLimit,
    onEvent: observeEvent,
  },
);
await artifactManager.initialize();

await observer.tick();

const app = createApp({
  registry,
  getState: () => observer.getState(),
  control,
  apiToken: config.apiToken,
  managementToken: config.managementToken,
  artifactManager,
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

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  fetch: app.fetch,
});

console.log(`larm listening on http://${server.hostname}:${server.port}`);
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
  artifactManager.beginDrain();
  executionGate.beginDrain();
  clearInterval(interval);
  clearTimeout(reconciliationTimer);
  const deadline = Date.now() + config.shutdownTimeoutMs;
  const operationsDrained = await Promise.race([
    Promise.all([
      control.flush(),
      artifactManager.flush(),
      reconciliationInFlight ?? Promise.resolve(),
    ]).then(() => true),
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
