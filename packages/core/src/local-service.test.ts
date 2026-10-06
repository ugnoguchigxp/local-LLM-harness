import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { localServiceLeaseRequestSchema, parseLocalServices, localServiceRevision } from "./local-service";
import { ServiceResourceLedger } from "./service-resource-ledger";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
const doc = () => parse(readFileSync("config/local-node/local-services.yaml", "utf8"));
test("service registration rejects node/unit conflicts and consumer command injection", () => {
  const d = parseLocalServices(doc(), ["local-node"])[0]!;
  expect(localServiceRevision(d)).toBe(localServiceRevision({ ...d }));
  expect(() => parseLocalServices(doc(), ["other"])).toThrow();
  expect(() => localServiceLeaseRequestSchema.parse({ command: "sh" })).toThrow();
  const v = doc(); v.services.other = v.services["docling-desk"];
  expect(() => parseLocalServices(v, ["local-node"])).toThrow("duplicate");
});
test("shared ledger preserves static safety floor, live pending reservations and CPU-only admission", () => {
  const ledger = new ServiceResourceLedger();
  const now = Date.parse("2026-10-06T00:00:00Z");
  const registry: Registry = { nodes: [{ id: "n", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 16, reservedMemoryGB: 4 } }], runtimes: [], profiles: [], routes: [] };
  const state: ClusterState = { generatedAt: new Date(now).toISOString(), runtimes: [], node: { ...registry.nodes[0]!, online: true,
    telemetry: { status: "available", source: "test", observedAt: new Date(now).toISOString(), systemMemoryAvailableBytes: 8 * 1024 ** 3, systemMemoryTotalBytes: 16 * 1024 ** 3, acceleratorMemoryAvailableBytes: 0 } } };
  const input = { registry, state, allocations: [], now, maxAgeMs: 1000 };
  ledger.reserve("a", "n", 5 * 1024 ** 3, input);
  expect(() => ledger.reserve("b", "n", 4 * 1024 ** 3, input)).toThrow("live_memory_exhausted");
  ledger.observe("a", 3 * 1024 ** 3); expect(ledger.reservations()[0]!.pendingBytes).toBe(2 * 1024 ** 3);
  ledger.reserve("b", "n", 4 * 1024 ** 3, input);
  expect(() => ledger.reserve("c", "n", 4 * 1024 ** 3, input)).toThrow("memory_exhausted");
  ledger.release("a"); expect(ledger.reservations()).toHaveLength(1);
  expect(() => ledger.reserve("d", "n", 1, { ...input, now: now + 2000 })).toThrow("telemetry_unavailable");
});
