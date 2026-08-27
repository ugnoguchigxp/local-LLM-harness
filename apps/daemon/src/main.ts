import { join, resolve } from "node:path";
import { loadRegistry } from "@larm/core";
import { createRuntimeBackend } from "@larm/backends";
import { createApp } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";

const configDir = resolve(
  process.env.LARM_CONFIG_DIR ?? join(import.meta.dir, "../../../config"),
);
const port = Number(process.env.LARM_PORT ?? 9810);
const hostname = process.env.LARM_HOST ?? "127.0.0.1";
const observeIntervalMs = Number(process.env.LARM_OBSERVE_INTERVAL_MS ?? 2000);
const graceMs = Number(process.env.LARM_STARTING_GRACE_SECONDS ?? 300) * 1000;
const idleTtlMs = Number(process.env.LARM_PREFERRED_IDLE_TTL_SECONDS ?? 60) * 1000;

const registry = loadRegistry(configDir);
const backend = createRuntimeBackend(registry.runtimes);
const observer = new Observer(registry, backend, { graceMs });
const control = new ControlPlane(registry, backend, observer, { idleTtlMs });

await observer.tick();

const app = createApp({
  registry,
  getState: () => observer.getState(),
  control,
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
}, observeIntervalMs);

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
});

console.log(`larm listening on http://${server.hostname}:${server.port}`);
console.log(`config ${configDir}`);

process.on("SIGINT", () => {
  clearInterval(interval);
  server.stop(true);
  process.exit(0);
});
