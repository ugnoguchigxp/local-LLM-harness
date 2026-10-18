import { expect, test } from "bun:test";
import { LarmClient, LarmApiError } from "./index";

test("monitoring SDK uses the existing API bearer and common transport without claims, renewals or management secrets", async () => {
  const snapshot = await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/snapshot-idle.json", import.meta.url)).json();
  const events = await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/events-cancelled.json", import.meta.url)).json();
  const calls: { path: string; method: string; auth: string | null; management: string | null }[] = [];
  const client = new LarmClient({ baseUrl: "http://fixture", apiToken: "api-secret", managementToken: "management-secret", fetch: async (url, init) => {
    const headers = new Headers(init?.headers), path = new URL(String(url)).pathname;
    calls.push({ path: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), management: headers.get("x-larm-management-token") });
    return Response.json(path.endsWith("snapshot") ? snapshot : events, { headers: { "x-larm-boot-epoch": "epoch-other" } });
  } });
  expect((await client.getMonitoringSnapshot()).core.activeWorkloads.value).toBe(0);
  expect((await client.getMonitoringEvents({ cursor: "opaque cursor", limit: 2 })).events).toHaveLength(2);
  expect(calls).toHaveLength(2); expect(calls.every(c => c.method === "GET" && c.auth === "Bearer api-secret" && c.management === null)).toBe(true);
  expect(calls[1]!.path).toContain("cursor=opaque+cursor&limit=2"); expect(client.observedBootEpoch).toBeUndefined();
});
test("monitoring SDK exposes structured cursor errors across daemon epochs without masking them", async () => {
  const errors = [await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/cursor-expired.json", import.meta.url)).json(), await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/epoch-changed.json", import.meta.url)).json()];
  let i = 0;
  const client = new LarmClient({ baseUrl: "http://fixture", apiToken: "api-secret", fetch: async () => {
    const n = i++; return Response.json(errors[n], { status: n ? 409 : 410, headers: { "x-larm-boot-epoch": n ? "new-epoch" : "old-epoch" } });
  } });
  for (const [status, code] of [[410, "monitoring_cursor_expired"], [409, "monitoring_epoch_changed"]] as const) {
    try { await client.getMonitoringEvents({ cursor: "cursor" }); throw new Error("expected rejection"); }
    catch (e) { expect(e).toBeInstanceOf(LarmApiError); expect((e as LarmApiError).status).toBe(status); expect((e as LarmApiError).code).toBe(code); }
  }
  expect(i).toBe(2);
});
