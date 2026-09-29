import { expect, test } from "bun:test";
import type { ContextTokenizerIdentity } from "@larm/backends";
import type { ClusterState, Registry, RuntimeReleaseDefinition } from "@larm/core";
import { ContextRuntimeReadiness } from "./context-runtime-readiness";

const runtimeId = "managed-runtime";
const releaseId = "release";
const now = Date.parse("2026-09-29T00:00:10.000Z");
const identity: ContextTokenizerIdentity = {
  engineBuild: "engine-v1",
  contextLimitTokens: 8192,
  chatTemplateDigest: "a".repeat(64),
  tokenizerDigest: "b".repeat(64),
};
const registry = {
  runtimes: [{
    id: runtimeId,
    capability: ["llm.reasoning"],
    context: {
      class: "managed-context",
      allowedModes: ["source-rebuild"],
    },
    deployment: { endpoint: "http://127.0.0.1:8080" },
  }],
} as unknown as Registry;
const release = {
  id: releaseId,
  contextCertification: {
    engineBuild: "engine-v1",
    contextLimitTokens: identity.contextLimitTokens,
    chatTemplateDigest: identity.chatTemplateDigest,
    tokenizerDigest: identity.tokenizerDigest,
    verifiedModes: ["source-rebuild"],
  },
} as unknown as RuntimeReleaseDefinition;

function state(status: string, observedAt = new Date(now).toISOString()): ClusterState {
  return {
    runtimes: [{
      id: runtimeId,
      status,
      observedAt,
      health: { ok: true },
    }],
  } as unknown as ClusterState;
}

function create(input: {
  getState?: () => ClusterState;
  identity?: (endpoint: string, signal?: AbortSignal) => Promise<ContextTokenizerIdentity>;
  isDraining?: () => boolean;
  onProbe?: (runtime: string, release: string, ok: boolean) => void;
} = {}) {
  let currentState = input.getState?.() ?? state("HOT");
  const readiness = new ContextRuntimeReadiness({
    enabled: true,
    registry,
    releases: new Map([[releaseId, release]]),
    getState: input.getState ?? (() => currentState),
    getActiveRelease: () => releaseId,
    identity: input.identity ?? (async () => identity),
    isDraining: input.isDraining ?? (() => false),
    stateMaxAgeMs: 10_000,
    now: () => now,
    onProbe: input.onProbe ?? (() => {}),
  });
  return {
    readiness,
    setState: (value: ClusterState) => { currentState = value; },
  };
}

test("runtime readiness single-flights identity probes and reuses a fresh successful result", async () => {
  let calls = 0;
  let resolveIdentity!: (value: ContextTokenizerIdentity) => void;
  const events: unknown[][] = [];
  const value = create({
    identity: () => {
      calls += 1;
      return new Promise((resolve) => { resolveIdentity = resolve; });
    },
    onProbe: (...event) => events.push(event),
  });
  const first = value.readiness.refresh();
  const second = value.readiness.refresh();
  expect(calls).toBe(1);
  resolveIdentity(identity);
  await Promise.all([first, second]);
  expect(value.readiness.getProbe(runtimeId)).toMatchObject({
    release: releaseId,
    ok: true,
    reason: "context_probe_ok",
  });
  await value.readiness.refresh();
  expect(calls).toBe(1);
  expect(events).toEqual([[runtimeId, releaseId, true]]);
});

test("runtime readiness drops a cached proof when the runtime is no longer healthy and hot", async () => {
  const value = create();
  await value.readiness.refresh();
  expect(value.readiness.getProbe(runtimeId)?.ok).toBe(true);
  value.setState(state("COLD"));
  await value.readiness.refresh();
  expect(value.readiness.getProbe(runtimeId)).toBeUndefined();
});

test("runtime activation binds certification proof to a stable lease epoch", async () => {
  const value = create();
  await value.readiness.refresh();
  const active = value.readiness.activation(runtimeId);
  expect(active).toMatchObject({
    state: "ACTIVE",
    reason: "eligible_runtime_hot",
    release: releaseId,
    leaseEpoch: 1,
  });
  expect(value.readiness.activation(runtimeId).leaseEpoch).toBe(1);

  value.setState(state("COLD"));
  expect(value.readiness.activation(runtimeId)).toMatchObject({
    state: "STANDBY",
    leaseEpoch: 2,
  });
});

test("draining advances every known runtime epoch and changes the next active epoch", () => {
  const value = create();
  expect(value.readiness.advanceEpoch(runtimeId, "active:release")).toBe(1);
  expect(value.readiness.advanceEpoch(runtimeId, "active:release")).toBe(1);
  value.readiness.beginDrain();
  expect(value.readiness.advanceEpoch(runtimeId, "active:release")).toBe(3);
});
