import { expect, test } from "bun:test";
import { parseDaemonConfig, parseInferenceAuditConfig } from "./config";

test("daemon configuration has bounded production defaults", () => {
  const config = parseDaemonConfig({}, "/workspace/apps/daemon/src");
  expect(config.port).toBe(9810);
  expect(config.httpIdleTimeoutSeconds).toBe(0);
  expect(config.controlMaxBodyBytes).toBe(64 * 1024);
  expect(config.gatewayMaxBodyBytes).toBe(4 * 1024 * 1024);
  expect(config.embeddingMaxBodyBytes).toBe(2 * 1024 * 1024);
  expect(config.speechMaxBodyBytes).toBe(257 * 1024 * 1024);
  expect(config.idempotencyTtlMs).toBe(300_000);
  expect(config.idempotencyLimit).toBe(1_000);
  expect(config.activeAllocationLimit).toBe(1_000);
  expect(config.artifactOperationLimit).toBe(64);
  expect(config.recoveryGraceMs).toBe(60_000);
  expect(config.shutdownTimeoutMs).toBe(330_000);
  expect(config.telemetryMaxAgeMs).toBe(10_000);
  expect(config.connectionReadyTimeoutMs).toBe(300_000);
  expect(config.providerProbeTimeoutMs).toBe(15_000);
  expect(config.tlsCertFile).toBeUndefined();
  expect(config.inferenceAuditMode).toBe("off");
  expect(config.inferenceAuditRetentionMs).toBe(7 * 24 * 60 * 60 * 1_000);
  expect(config.inferenceAuditMaxBytes).toBe(10 * 1024 * 1024 * 1024);
  expect(config.inferenceAuditMinFreeBytes).toBe(20 * 1024 * 1024 * 1024);
  expect(config.inferenceAuditMaxResponseBytes).toBe(16 * 1024 * 1024);
  expect(config.inferenceAuditRoot).toBe("/var/lib/larm/inference-audit");
  expect(config.inferenceAuditKeyFile).toBe("/etc/larm/inference-audit.key");
  expect(config.connectionSigningKey).toBeUndefined();
  expect(config.allowAnonymousAgentConnections).toBeFalse();
  expect(config.serviceHarnessAuthEnabled).toBeFalse();
  expect(config.contextEnabled).toBeFalse();
  expect(config.contextMetadataRoot).toBe("/var/lib/larm/contexts");
  expect(config.contextSourceRoot).toBe("/srv/ai/context-sources");
  expect(config.contextSourceMaxBytes).toBe(256 * 1024 * 1024);
  expect(config.contextSourceMaxTotalBytes).toBe(512 * 1024 * 1024 * 1024);
  expect(config.contextMaterializedMaxBytes).toBe(64 * 1024 * 1024);
  expect(config.personalStateEnabled).toBeFalse();
  expect(config.personalStateJournalRoot).toBe("/var/lib/larm/personal-state");
  expect(config.personalStateReceiptTtlMs).toBe(24 * 60 * 60 * 1_000);
  expect(config.musicProviderEndpoint).toBeUndefined();
  expect(config.musicArtifactRoot).toBe("/var/lib/larm/music");
  expect(config.musicPollIntervalMs).toBe(1_000);
  expect(config.musicMaxAudioBytes).toBe(512 * 1024 * 1024);
  expect(config.musicArtifactRetentionMs).toBe(24 * 60 * 60 * 1_000);
  expect(config.musicWavRetentionMs).toBe(60 * 60 * 1_000);
  expect(config.musicArtifactMaxBytes).toBe(50 * 1024 * 1024 * 1024);
  expect(config.musicFavoriteMaxBytes).toBe(30 * 1024 * 1024 * 1024);
  expect(config.musicPruneIntervalMs).toBe(5 * 60 * 1_000);
  expect(config.musicUpstreamOutputRoot).toBeUndefined();
  expect(config.imageArtifactRoot).toBe("/srv/ai/data/generated/images");
  expect(config.imageArtifactMaxBytes).toBe(20_000_000_000);
  expect(config.imageArtifactTargetBytes).toBe(18_000_000_000);
  expect(config.imagePruneIntervalMs).toBe(5 * 60 * 1_000);
  expect(config.configDir).toBe("/workspace/config/local-node");
});

test("daemon configuration rejects invalid numbers", () => {
  expect(() => parseDaemonConfig({ LARM_PORT: "NaN" })).toThrow(/LARM_PORT/);
  expect(() => parseDaemonConfig({ LARM_PORT: "70000" })).toThrow(/LARM_PORT/);
  expect(() => parseDaemonConfig({ LARM_HTTP_IDLE_TIMEOUT_SECONDS: "256" })).toThrow(
    /LARM_HTTP_IDLE_TIMEOUT_SECONDS/,
  );
  expect(() => parseDaemonConfig({ LARM_GATEWAY_MAX_BODY_BYTES: "0" })).toThrow(
    /LARM_GATEWAY_MAX_BODY_BYTES/,
  );
  expect(() => parseDaemonConfig({ LARM_EMBEDDING_MAX_BODY_BYTES: "0" })).toThrow(
    /LARM_EMBEDDING_MAX_BODY_BYTES/,
  );
  expect(() => parseDaemonConfig({ LARM_CONTROL_MAX_BODY_BYTES: String(1024 * 1024 + 1) }))
    .toThrow(/LARM_CONTROL_MAX_BODY_BYTES/);
  expect(() => parseDaemonConfig({ LARM_GATEWAY_MAX_BODY_BYTES: String(64 * 1024 * 1024 + 1) }))
    .toThrow(/LARM_GATEWAY_MAX_BODY_BYTES/);
  expect(() => parseDaemonConfig({ LARM_ACTIVE_ALLOCATION_LIMIT: "0" })).toThrow(
    /LARM_ACTIVE_ALLOCATION_LIMIT/,
  );
  expect(() => parseDaemonConfig({ LARM_ARTIFACT_OPERATION_LIMIT: "0" })).toThrow(
    /LARM_ARTIFACT_OPERATION_LIMIT/,
  );
  expect(() => parseDaemonConfig({ LARM_TELEMETRY_MAX_AGE_SECONDS: "0" })).toThrow(
    /LARM_TELEMETRY_MAX_AGE_SECONDS/,
  );
  expect(() => parseDaemonConfig({ LARM_CONNECTION_READY_TIMEOUT_SECONDS: "901" })).toThrow(
    /LARM_CONNECTION_READY_TIMEOUT_SECONDS/,
  );
  expect(() => parseDaemonConfig({ LARM_PROVIDER_PROBE_TIMEOUT_SECONDS: "61" })).toThrow(
    /LARM_PROVIDER_PROBE_TIMEOUT_SECONDS/,
  );
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_MODE: "optional" })).toThrow();
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_RETENTION_SECONDS: "604801" }))
    .toThrow(/LARM_INFERENCE_AUDIT_RETENTION_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_MAX_BYTES: "0" }))
    .toThrow(/LARM_INFERENCE_AUDIT_MAX_BYTES/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_MAX_BYTES: String(129 * 1024 * 1024) }))
    .toThrow(/payload reservations/);
  expect(() => parseDaemonConfig({
    LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES: String(64 * 1024 * 1024 + 1),
  })).toThrow(/LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES/);
  expect(parseDaemonConfig({ LARM_GATEWAY_TIMEOUT_SECONDS: "7200" }).gatewayTimeoutMs)
    .toBe(7_200_000);
  expect(() => parseDaemonConfig({ LARM_GATEWAY_TIMEOUT_SECONDS: "7201" }))
    .toThrow(/LARM_GATEWAY_TIMEOUT_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_ROOT: "relative/audit" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_KEY_FILE: "relative.key" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_CONTEXT_SOURCE_ROOT: "relative/context" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_ARTIFACT_ROOT: "relative/music" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_UPSTREAM_OUTPUT_ROOT: "relative/output" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_IMAGE_ARTIFACT_ROOT: "relative/images" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_IMAGE_ARTIFACT_MAX_BYTES: "0" }))
    .toThrow(/LARM_IMAGE_ARTIFACT_MAX_BYTES/);
  expect(() => parseDaemonConfig({
    LARM_IMAGE_ARTIFACT_MAX_BYTES: "1000",
    LARM_IMAGE_ARTIFACT_TARGET_BYTES: "1000",
  })).toThrow(/LARM_IMAGE_ARTIFACT_TARGET_BYTES/);
  expect(() => parseDaemonConfig({ LARM_IMAGE_PRUNE_INTERVAL_SECONDS: "9" }))
    .toThrow(/LARM_IMAGE_PRUNE_INTERVAL_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_ARTIFACT_RETENTION_SECONDS: "59" }))
    .toThrow(/LARM_MUSIC_ARTIFACT_RETENTION_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_WAV_RETENTION_SECONDS: "59" }))
    .toThrow(/LARM_MUSIC_WAV_RETENTION_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_ARTIFACT_MAX_BYTES: "1023" }))
    .toThrow(/LARM_MUSIC_ARTIFACT_MAX_BYTES/);
  expect(() => parseDaemonConfig({
    LARM_MUSIC_ARTIFACT_MAX_BYTES: String(20 * 1024 * 1024),
    LARM_MUSIC_FAVORITE_MAX_BYTES: String(30 * 1024 * 1024),
  })).toThrow(/LARM_MUSIC_FAVORITE_MAX_BYTES/);
  expect(() => parseDaemonConfig({ LARM_MUSIC_PROVIDER_ENDPOINT: "ftp://localhost:8001" }))
    .toThrow(/LARM_MUSIC_PROVIDER_ENDPOINT/);
  expect(() => parseDaemonConfig({ LARM_CONTEXT_MATERIALIZED_MAX_BYTES: "0" }))
    .toThrow(/LARM_CONTEXT_MATERIALIZED_MAX_BYTES/);
  expect(() => parseDaemonConfig({ LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES: "0" }))
    .toThrow(/LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES/);
});

test("TLS certificate and key paths are paired and absolute", () => {
  expect(() => parseDaemonConfig({ LARM_TLS_CERT_FILE: "/etc/larm/tls.crt" }))
    .toThrow(/configured together/);
  expect(() => parseDaemonConfig({
    LARM_TLS_CERT_FILE: "tls.crt",
    LARM_TLS_KEY_FILE: "tls.key",
  })).toThrow(/absolute paths/);
  expect(parseDaemonConfig({
    LARM_TLS_CERT_FILE: "/etc/larm/tls.crt",
    LARM_TLS_KEY_FILE: "/etc/larm/tls.key",
  })).toMatchObject({
    tlsCertFile: "/etc/larm/tls.crt",
    tlsKeyFile: "/etc/larm/tls.key",
  });
});

test("standalone audit configuration ignores unrelated daemon settings", () => {
  const config = parseInferenceAuditConfig({
    LARM_HOST: "0.0.0.0",
    LARM_PORT: "invalid",
    LARM_INFERENCE_AUDIT_MIN_FREE_BYTES: "0",
  });
  expect(config.inferenceAuditMinFreeBytes).toBe(0);
  expect(config.inferenceAuditRoot).toBe("/var/lib/larm/inference-audit");
});

test("connection signing key is canonical unpadded base64url for 32 bytes", () => {
  const encoded = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");
  expect(parseDaemonConfig({ LARM_CONNECTION_SIGNING_KEY: encoded }).connectionSigningKey)
    .toEqual(new Uint8Array(32).fill(9));
  expect(() => parseDaemonConfig({ LARM_CONNECTION_SIGNING_KEY: "too-short" }))
    .toThrow(/LARM_CONNECTION_SIGNING_KEY/);
  expect(() => parseDaemonConfig({ LARM_CONNECTION_SIGNING_KEY: `${encoded}=` }))
    .toThrow(/LARM_CONNECTION_SIGNING_KEY/);
});

test("non-loopback listeners require both API tokens", () => {
  expect(() => parseDaemonConfig({ LARM_HOST: "0.0.0.0" })).toThrow(/LARM_API_TOKEN/);
  expect(() => parseDaemonConfig({
    LARM_HOST: "0.0.0.0",
    LARM_API_TOKEN: "api",
  })).toThrow(/LARM_MANAGEMENT_TOKEN/);
  const config = parseDaemonConfig({
    LARM_HOST: "0.0.0.0",
    LARM_API_TOKEN: "api",
    LARM_MANAGEMENT_TOKEN: "management",
    LARM_ALLOW_ANONYMOUS_AGENT_CONNECTIONS: "true",
  });
  expect(config.hostname).toBe("0.0.0.0");
  expect(config.allowAnonymousAgentConnections).toBeTrue();
  expect(parseDaemonConfig({
    LARM_SERVICE_HARNESS_AUTH_ENABLED: "true",
    LARM_API_TOKEN: "api",
  }).serviceHarnessAuthEnabled).toBeTrue();
  expect(() => parseDaemonConfig({
    LARM_SERVICE_HARNESS_AUTH_ENABLED: "true",
  })).toThrow(/Service Harness authentication/);
  expect(() => parseDaemonConfig({
    LARM_ALLOW_ANONYMOUS_AGENT_CONNECTIONS: "yes",
  })).toThrow(/must be true or false/);
  expect(() => parseDaemonConfig({
    LARM_SERVICE_HARNESS_AUTH_ENABLED: "yes",
  })).toThrow(/must be true or false/);
});

test("managed context requires an API token even on loopback", () => {
  expect(() => parseDaemonConfig({ LARM_CONTEXT_ENABLED: "true" }))
    .toThrow(/LARM_API_TOKEN/);
  expect(parseDaemonConfig({
    LARM_CONTEXT_ENABLED: "true",
    LARM_API_TOKEN: "api",
  }).contextEnabled).toBeTrue();
  expect(() => parseDaemonConfig({ LARM_PERSONAL_STATE_ENABLED: "true" }))
    .toThrow(/LARM_CONTEXT_ENABLED/);
  expect(() => parseDaemonConfig({
    LARM_PERSONAL_STATE_ENABLED: "true",
    LARM_CONTEXT_ENABLED: "true",
    LARM_API_TOKEN: "api",
  })).toThrow(/LARM_CONNECTION_SIGNING_KEY/);
  expect(parseDaemonConfig({
    LARM_PERSONAL_STATE_ENABLED: "true",
    LARM_CONTEXT_ENABLED: "true",
    LARM_API_TOKEN: "api",
    LARM_CONNECTION_SIGNING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  }).personalStateEnabled).toBeTrue();
  expect(() => parseDaemonConfig({
    LARM_PERSONAL_STATE_JOURNAL_ROOT: "/srv/ai/context-sources/personal-state",
  })).toThrow(/must not overlap/);
});
