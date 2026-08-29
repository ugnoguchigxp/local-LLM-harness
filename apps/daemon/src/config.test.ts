import { expect, test } from "bun:test";
import { parseDaemonConfig } from "./config";

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
  expect(config.connectionSigningKey).toBeUndefined();
  expect(config.configDir).toBe("/workspace/config/gnosis");
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
  expect(parseDaemonConfig({
    LARM_HOST: "0.0.0.0",
    LARM_API_TOKEN: "api",
    LARM_MANAGEMENT_TOKEN: "management",
  }).hostname).toBe("0.0.0.0");
});
