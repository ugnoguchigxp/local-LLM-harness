import { isAbsolute, join, resolve } from "node:path";
import { inferenceAuditModeSchema, type InferenceAuditMode } from "@larm/core";

type Environment = Record<string, string | undefined>;

export type DaemonConfig = {
  configDir: string;
  port: number;
  hostname: string;
  httpIdleTimeoutSeconds: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  observeIntervalMs: number;
  graceMs: number;
  idleTtlMs: number;
  startupTimeoutMs: number;
  pollIntervalMs: number;
  stateMaxAgeMs: number;
  historyLimit: number;
  activeAllocationLimit: number;
  apiToken?: string;
  allowAnonymousAgentConnections: boolean;
  serviceHarnessAuthEnabled: boolean;
  managementToken?: string;
  connectionSigningKey?: Uint8Array;
  connectionReadyTimeoutMs: number;
  providerProbeTimeoutMs: number;
  gatewayTimeoutMs: number;
  controlMaxBodyBytes: number;
  gatewayMaxBodyBytes: number;
  embeddingMaxBodyBytes: number;
  speechMaxBodyBytes: number;
  shutdownTimeoutMs: number;
  artifactManifestPath: string;
  releaseCatalogPath: string;
  artifactStagingRoot: string;
  artifactRollbackRoot: string;
  artifactStateRoot: string;
  idempotencyTtlMs: number;
  idempotencyLimit: number;
  recoveryGraceMs: number;
  artifactOperationLimit: number;
  telemetryMaxAgeMs: number;
  inferenceAuditMode: InferenceAuditMode;
  inferenceAuditRoot: string;
  inferenceAuditKeyFile: string;
  inferenceAuditRetentionMs: number;
  inferenceAuditMaxBytes: number;
  inferenceAuditMinFreeBytes: number;
  inferenceAuditMaxResponseBytes: number;
  inferenceAuditMaterializationTimeoutMs: number;
  contextEnabled: boolean;
  contextMetadataRoot: string;
  contextSourceRoot: string;
  contextSourceMaxBytes: number;
  contextSourceMaxTotalBytes: number;
  contextMaterializedMaxBytes: number;
  personalStateEnabled: boolean;
  personalStateJournalRoot: string;
  personalStateReceiptTtlMs: number;
};

export type InferenceAuditConfig = Pick<
  DaemonConfig,
  | "inferenceAuditMode"
  | "inferenceAuditRoot"
  | "inferenceAuditKeyFile"
  | "inferenceAuditRetentionMs"
  | "inferenceAuditMaxBytes"
  | "inferenceAuditMinFreeBytes"
  | "inferenceAuditMaxResponseBytes"
  | "inferenceAuditMaterializationTimeoutMs"
>;

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
  max = 2_147_483,
): number {
  return numberSetting(env, name, fallback, { min, max }) * 1_000;
}

function booleanSetting(
  env: Environment,
  name: string,
  fallback: boolean,
): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalSecret(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function absolutePathSetting(env: Environment, name: string, fallback: string): string {
  const value = env[name] ?? fallback;
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function connectionSigningKey(value: string | undefined): Uint8Array | undefined {
  const raw = optionalSecret(value);
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error("LARM_CONNECTION_SIGNING_KEY must be unpadded base64url for exactly 32 bytes");
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== raw) {
    throw new Error("LARM_CONNECTION_SIGNING_KEY must be unpadded base64url for exactly 32 bytes");
  }
  return decoded;
}

export function parseInferenceAuditConfig(
  env: Environment = process.env,
): InferenceAuditConfig {
  const inferenceAuditMaxBytes = numberSetting(
    env,
    "LARM_INFERENCE_AUDIT_MAX_BYTES",
    10 * 1024 * 1024 * 1024,
    { min: 1, max: 1024 * 1024 * 1024 * 1024, integer: true },
  );
  const inferenceAuditMaxResponseBytes = numberSetting(
    env,
    "LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES",
    16 * 1024 * 1024,
    { min: 1, max: 64 * 1024 * 1024, integer: true },
  );
  if (
    inferenceAuditMaxBytes
      <= inferenceAuditMaxResponseBytes + 129 * 1024 * 1024
  ) {
    throw new Error(
      "LARM_INFERENCE_AUDIT_MAX_BYTES is too small for the configured audit payload reservations",
    );
  }
  return {
    inferenceAuditMode: inferenceAuditModeSchema.parse(
      env.LARM_INFERENCE_AUDIT_MODE ?? "off",
    ),
    inferenceAuditRoot: absolutePathSetting(
      env,
      "LARM_INFERENCE_AUDIT_ROOT",
      "/var/lib/larm/inference-audit",
    ),
    inferenceAuditKeyFile: absolutePathSetting(
      env,
      "LARM_INFERENCE_AUDIT_KEY_FILE",
      "/etc/larm/inference-audit.key",
    ),
    inferenceAuditRetentionMs: secondsSetting(
      env,
      "LARM_INFERENCE_AUDIT_RETENTION_SECONDS",
      7 * 24 * 60 * 60,
      1,
      7 * 24 * 60 * 60,
    ),
    inferenceAuditMaxBytes,
    inferenceAuditMinFreeBytes: numberSetting(
      env,
      "LARM_INFERENCE_AUDIT_MIN_FREE_BYTES",
      20 * 1024 * 1024 * 1024,
      { min: 0, max: 1024 * 1024 * 1024 * 1024, integer: true },
    ),
    inferenceAuditMaxResponseBytes,
    inferenceAuditMaterializationTimeoutMs: secondsSetting(
      env,
      "LARM_INFERENCE_AUDIT_MATERIALIZATION_TIMEOUT_SECONDS",
      30,
      0.001,
      300,
    ),
  };
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
  const serviceHarnessAuthEnabled = booleanSetting(
    env,
    "LARM_SERVICE_HARNESS_AUTH_ENABLED",
    false,
  );
  const managementToken = optionalSecret(env.LARM_MANAGEMENT_TOKEN);
  const tlsCertFile = optionalSecret(env.LARM_TLS_CERT_FILE);
  const tlsKeyFile = optionalSecret(env.LARM_TLS_KEY_FILE);
  if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined)) {
    throw new Error("LARM_TLS_CERT_FILE and LARM_TLS_KEY_FILE must be configured together");
  }
  if (tlsCertFile && (!isAbsolute(tlsCertFile) || !isAbsolute(tlsKeyFile!))) {
    throw new Error("LARM TLS certificate and key files must use absolute paths");
  }
  const inferenceAudit = parseInferenceAuditConfig(env);
  const contextEnabled = booleanSetting(env, "LARM_CONTEXT_ENABLED", false);
  const personalStateEnabled = booleanSetting(env, "LARM_PERSONAL_STATE_ENABLED", false);
  const contextMetadataRoot = absolutePathSetting(env, "LARM_CONTEXT_METADATA_ROOT", "/var/lib/larm/contexts");
  const contextSourceRoot = absolutePathSetting(env, "LARM_CONTEXT_SOURCE_ROOT", "/srv/ai/context-sources");
  const personalStateJournalRoot = absolutePathSetting(
    env,
    "LARM_PERSONAL_STATE_JOURNAL_ROOT",
    "/var/lib/larm/personal-state",
  );
  const overlaps = (left: string, right: string) => left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(hostname) && !apiToken) {
    throw new Error("LARM_API_TOKEN is required when LARM_HOST is not loopback");
  }
  if (!loopbackHosts.has(hostname) && !managementToken) {
    throw new Error("LARM_MANAGEMENT_TOKEN is required when LARM_HOST is not loopback");
  }
  if (serviceHarnessAuthEnabled && !apiToken) {
    throw new Error("LARM_API_TOKEN is required when Service Harness authentication is enabled");
  }
  if (contextEnabled && !apiToken) {
    throw new Error("LARM_API_TOKEN is required when managed context is enabled");
  }
  if (personalStateEnabled && !contextEnabled) {
    throw new Error("LARM_CONTEXT_ENABLED must be true when Personal State delivery is enabled");
  }
  if (personalStateEnabled && !connectionSigningKey(env.LARM_CONNECTION_SIGNING_KEY)) {
    throw new Error("LARM_CONNECTION_SIGNING_KEY is required when Personal State delivery is enabled");
  }
  if (
    overlaps(personalStateJournalRoot, contextMetadataRoot)
    || overlaps(personalStateJournalRoot, contextSourceRoot)
  ) {
    throw new Error("LARM_PERSONAL_STATE_JOURNAL_ROOT must not overlap context data roots");
  }

  return {
    configDir: resolve(env.LARM_CONFIG_DIR ?? join(sourceDir, "../../../config/local-node")),
    port: numberSetting(env, "LARM_PORT", 9810, { min: 1, max: 65_535, integer: true }),
    hostname,
    httpIdleTimeoutSeconds: numberSetting(env, "LARM_HTTP_IDLE_TIMEOUT_SECONDS", 0, {
      min: 0,
      max: 255,
      integer: true,
    }),
    ...(tlsCertFile && tlsKeyFile
      ? { tlsCertFile: resolve(tlsCertFile), tlsKeyFile: resolve(tlsKeyFile) }
      : {}),
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
    allowAnonymousAgentConnections: booleanSetting(
      env,
      "LARM_ALLOW_ANONYMOUS_AGENT_CONNECTIONS",
      false,
    ),
    serviceHarnessAuthEnabled,
    managementToken,
    connectionSigningKey: connectionSigningKey(env.LARM_CONNECTION_SIGNING_KEY),
    connectionReadyTimeoutMs: secondsSetting(
      env,
      "LARM_CONNECTION_READY_TIMEOUT_SECONDS",
      300,
      1,
      900,
    ),
    providerProbeTimeoutMs: secondsSetting(
      env,
      "LARM_PROVIDER_PROBE_TIMEOUT_SECONDS",
      15,
      1,
      60,
    ),
    gatewayTimeoutMs: secondsSetting(
      env,
      "LARM_GATEWAY_TIMEOUT_SECONDS",
      300,
      0.001,
      7_200,
    ),
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
    embeddingMaxBodyBytes: numberSetting(
      env,
      "LARM_EMBEDDING_MAX_BODY_BYTES",
      2 * 1024 * 1024,
      { min: 1, max: 16 * 1024 * 1024, integer: true },
    ),
    speechMaxBodyBytes: numberSetting(
      env,
      "LARM_SPEECH_MAX_BODY_BYTES",
      257 * 1024 * 1024,
      { min: 1, max: 1024 * 1024 * 1024, integer: true },
    ),
    shutdownTimeoutMs: secondsSetting(env, "LARM_SHUTDOWN_TIMEOUT_SECONDS", 330, 0.001),
    artifactManifestPath: resolve(
      env.LARM_ARTIFACT_MANIFEST ?? join(sourceDir, "../../../deploy/local-node/models.yaml"),
    ),
    releaseCatalogPath: resolve(
      env.LARM_RELEASE_CATALOG ?? join(sourceDir, "../../../deploy/local-node/releases.yaml"),
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
    telemetryMaxAgeMs: secondsSetting(env, "LARM_TELEMETRY_MAX_AGE_SECONDS", 10, 0.001),
    contextEnabled,
    contextMetadataRoot,
    contextSourceRoot,
    contextSourceMaxBytes: numberSetting(
      env,
      "LARM_CONTEXT_SOURCE_MAX_BYTES",
      256 * 1024 * 1024,
      { min: 1, max: 2 * 1024 * 1024 * 1024, integer: true },
    ),
    contextSourceMaxTotalBytes: numberSetting(
      env,
      "LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES",
      512 * 1024 * 1024 * 1024,
      { min: 1, max: 2 * 1024 * 1024 * 1024 * 1024, integer: true },
    ),
    contextMaterializedMaxBytes: numberSetting(
      env,
      "LARM_CONTEXT_MATERIALIZED_MAX_BYTES",
      64 * 1024 * 1024,
      { min: 1, max: 2 * 1024 * 1024 * 1024, integer: true },
    ),
    personalStateEnabled,
    personalStateJournalRoot,
    personalStateReceiptTtlMs: secondsSetting(
      env,
      "LARM_PERSONAL_STATE_RECEIPT_TTL_SECONDS",
      24 * 60 * 60,
      60,
      7 * 24 * 60 * 60,
    ),
    ...inferenceAudit,
  };
}
