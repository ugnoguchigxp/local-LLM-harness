import { join, resolve } from "node:path";

type Environment = Record<string, string | undefined>;

export type DaemonConfig = {
  configDir: string;
  port: number;
  hostname: string;
  observeIntervalMs: number;
  graceMs: number;
  idleTtlMs: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  stateMaxAgeMs: number;
  historyLimit: number;
  activeAllocationLimit: number;
  apiToken?: string;
  managementToken?: string;
  gatewayTimeoutMs: number;
  controlMaxBodyBytes: number;
  gatewayMaxBodyBytes: number;
  speechMaxBodyBytes: number;
  shutdownTimeoutMs: number;
  artifactManifestPath: string;
  artifactStagingRoot: string;
  artifactRollbackRoot: string;
  artifactStateRoot: string;
  idempotencyTtlMs: number;
  idempotencyLimit: number;
  recoveryGraceMs: number;
  artifactOperationLimit: number;
};

function numberSetting(
  env: Environment,
  name: string,
  fallback: number,
  options: { min: number; max?: number; integer?: boolean },
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isFinite(value)
    || value < options.min
    || (options.max !== undefined && value > options.max)
    || (options.integer && !Number.isInteger(value))
  ) {
    throw new Error(`${name} has an invalid numeric value`);
  }
  return value;
}

function secondsSetting(
  env: Environment,
  name: string,
  fallback: number,
  min = 0,
): number {
  return numberSetting(env, name, fallback, { min, max: 2_147_483 }) * 1_000;
}

function optionalSecret(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function parseDaemonConfig(
  env: Environment = process.env,
  sourceDir = import.meta.dir,
): DaemonConfig {
  const hostname = env.LARM_HOST ?? "127.0.0.1";
  if (hostname.length === 0) {
    throw new Error("LARM_HOST must not be empty");
  }
  const apiToken = optionalSecret(env.LARM_API_TOKEN);
  const managementToken = optionalSecret(env.LARM_MANAGEMENT_TOKEN);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(hostname) && !apiToken) {
    throw new Error("LARM_API_TOKEN is required when LARM_HOST is not loopback");
  }
  if (!loopbackHosts.has(hostname) && !managementToken) {
    throw new Error("LARM_MANAGEMENT_TOKEN is required when LARM_HOST is not loopback");
  }

  return {
    configDir: resolve(env.LARM_CONFIG_DIR ?? join(sourceDir, "../../../config/gnosis")),
    port: numberSetting(env, "LARM_PORT", 9810, { min: 1, max: 65_535, integer: true }),
    hostname,
    observeIntervalMs: numberSetting(env, "LARM_OBSERVE_INTERVAL_MS", 2_000, {
      min: 1,
      max: 2_147_483_647,
      integer: true,
    }),
    graceMs: secondsSetting(env, "LARM_STARTING_GRACE_SECONDS", 300),
    idleTtlMs: secondsSetting(env, "LARM_PREFERRED_IDLE_TTL_SECONDS", 60),
    startupTimeoutMs: secondsSetting(env, "LARM_STARTUP_TIMEOUT_SECONDS", 300, 0.001),
    pollIntervalMs: numberSetting(env, "LARM_STARTUP_POLL_INTERVAL_MS", 500, {
      min: 1,
      max: 2_147_483_647,
      integer: true,
    }),
    stateMaxAgeMs: secondsSetting(env, "LARM_STATE_MAX_AGE_SECONDS", 10, 0.001),
    historyLimit: numberSetting(env, "LARM_HISTORY_LIMIT", 1_000, {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    activeAllocationLimit: numberSetting(env, "LARM_ACTIVE_ALLOCATION_LIMIT", 1_000, {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    apiToken,
    managementToken,
    gatewayTimeoutMs: secondsSetting(env, "LARM_GATEWAY_TIMEOUT_SECONDS", 300, 0.001),
    controlMaxBodyBytes: numberSetting(env, "LARM_CONTROL_MAX_BODY_BYTES", 64 * 1024, {
      min: 1,
      max: 1024 * 1024,
      integer: true,
    }),
    gatewayMaxBodyBytes: numberSetting(
      env,
      "LARM_GATEWAY_MAX_BODY_BYTES",
      4 * 1024 * 1024,
      { min: 1, max: 64 * 1024 * 1024, integer: true },
    ),
    speechMaxBodyBytes: numberSetting(
      env,
      "LARM_SPEECH_MAX_BODY_BYTES",
      257 * 1024 * 1024,
      { min: 1, max: 1024 * 1024 * 1024, integer: true },
    ),
    shutdownTimeoutMs: secondsSetting(env, "LARM_SHUTDOWN_TIMEOUT_SECONDS", 330, 0.001),
    artifactManifestPath: resolve(
      env.LARM_ARTIFACT_MANIFEST ?? join(sourceDir, "../../../deploy/gnosis/models.yaml"),
    ),
    artifactStagingRoot: resolve(
      env.LARM_ARTIFACT_STAGING_ROOT ?? "/srv/ai/models/.larm-staging",
    ),
    artifactRollbackRoot: resolve(
      env.LARM_ARTIFACT_ROLLBACK_ROOT ?? "/srv/ai/models/.larm-rollback",
    ),
    artifactStateRoot: resolve(env.LARM_ARTIFACT_STATE_ROOT ?? "/var/lib/larm"),
    idempotencyTtlMs: secondsSetting(env, "LARM_IDEMPOTENCY_TTL_SECONDS", 300, 0.001),
    idempotencyLimit: numberSetting(env, "LARM_IDEMPOTENCY_LIMIT", 1_000, {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    recoveryGraceMs: secondsSetting(env, "LARM_RECOVERY_GRACE_SECONDS", 60),
    artifactOperationLimit: numberSetting(env, "LARM_ARTIFACT_OPERATION_LIMIT", 64, {
      min: 1,
      max: 10_000,
      integer: true,
    }),
  };
}
