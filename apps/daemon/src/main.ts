import { loadArtifactManifest, loadRegistry } from "@larm/core";
import { createRuntimeBackend, LocalArtifactStore } from "@larm/backends";
import { createApp } from "./app";
import { ArtifactManager } from "./artifact-manager";
import { parseDaemonConfig } from "./config";
import { ControlPlane, type ControlEvent } from "./controller";
import { MetricsRegistry, RequestTracker } from "./metrics";
import { Observer } from "./observer";

const config = parseDaemonConfig();

const registry = loadRegistry(config.configDir);
const backend = createRuntimeBackend(registry.runtimes);
const observer = new Observer(registry, backend, { graceMs: config.graceMs });
const metrics = new MetricsRegistry();
const requestTracker = new RequestTracker();
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
  writeEvent(event);
};
const artifactStore = new LocalArtifactStore({
  stagingRoot: config.artifactStagingRoot,
  rollbackRoot: config.artifactRollbackRoot,
  stateRoot: config.artifactStateRoot,
});
let artifactManager: ArtifactManager;
const control = new ControlPlane(registry, backend, observer, {
  idleTtlMs: config.idleTtlMs,
  startupTimeoutMs: config.startupTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
  historyLimit: config.historyLimit,
  stateMaxAgeMs: config.stateMaxAgeMs,
  isRuntimeMutating: (runtimeId) => artifactManager?.isRuntimeMutating(runtimeId) ?? false,
  onEvent: observeEvent,
  deploymentCoordinator: {
    ensureRuntime: (runtimeId, allocationId, onPhase, signal) =>
      artifactManager.ensureRuntime(runtimeId, allocationId, onPhase, signal),
  },
});
artifactManager = new ArtifactManager(
  loadArtifactManifest(config.artifactManifestPath),
  registry,
  artifactStore,
  backend,
  observer,
  {
    activeAllocations: () => control.getAllocations(),
    historyLimit: config.historyLimit,
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
  gatewayTimeoutMs: config.gatewayTimeoutMs,
  stateMaxAgeMs: config.stateMaxAgeMs,
  onEvent: writeEvent,
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

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`received ${signal}; draining`);
  control.beginDrain();
  artifactManager.beginDrain();
  clearInterval(interval);
  const deadline = Date.now() + config.shutdownTimeoutMs;
  const operationsDrained = await Promise.race([
    Promise.all([control.flush(), artifactManager.flush()]).then(() => true),
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
