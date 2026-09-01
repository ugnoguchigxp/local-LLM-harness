import { expect, test } from "bun:test";
import { parseDaemonConfig, parseInferenceAuditConfig } from "./config";

test("daemon configuration has bounded production defaults", () => {
  const config = parseDaemonConfig({}, "/workspace/apps/daemon/src");
  expect(config.port).toBe(9810);
  expect(config.controlMaxBodyBytes).toBe(64 * 1024);
  expect(config.gatewayMaxBodyBytes).toBe(4 * 1024 * 1024);
  expect(config.speechMaxBodyBytes).toBe(257 * 1024 * 1024);
  expect(config.idempotencyTtlMs).toBe(300_000);
  expect(config.idempotencyLimit).toBe(1_000);
  expect(config.activeAllocationLimit).toBe(1_000);
  expect(config.artifactOperationLimit).toBe(64);
  expect(config.recoveryGraceMs).toBe(60_000);
  expect(config.shutdownTimeoutMs).toBe(330_000);
  expect(config.telemetryMaxAgeMs).toBe(10_000);
  expect(config.connectionReadyTimeoutMs).toBe(120_000);
  expect(config.providerProbeTimeoutMs).toBe(15_000);
  expect(config.nativeStreamConnectTimeoutMs).toBe(5_000);
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
  expect(config.configDir).toBe("/workspace/config/local-node");
});

test("daemon configuration rejects invalid numbers", () => {
  expect(() => parseDaemonConfig({ LARM_PORT: "NaN" })).toThrow(/LARM_PORT/);
  expect(() => parseDaemonConfig({ LARM_PORT: "70000" })).toThrow(/LARM_PORT/);
  expect(() => parseDaemonConfig({ LARM_GATEWAY_MAX_BODY_BYTES: "0" })).toThrow(
    /LARM_GATEWAY_MAX_BODY_BYTES/,
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
  expect(() => parseDaemonConfig({ LARM_NATIVE_STREAM_CONNECT_TIMEOUT_MS: "99" })).toThrow(
    /LARM_NATIVE_STREAM_CONNECT_TIMEOUT_MS/,
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
  expect(() => parseDaemonConfig({ LARM_GATEWAY_TIMEOUT_SECONDS: "3600" }))
    .toThrow(/LARM_GATEWAY_TIMEOUT_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_GATEWAY_TIMEOUT_SECONDS: "3301" }))
    .toThrow(/LARM_GATEWAY_TIMEOUT_SECONDS/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_ROOT: "relative/audit" }))
    .toThrow(/absolute path/);
  expect(() => parseDaemonConfig({ LARM_INFERENCE_AUDIT_KEY_FILE: "relative.key" }))
    .toThrow(/absolute path/);
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
