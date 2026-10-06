import { expect, test } from "bun:test";
import { ClientLocalServices } from "./client-local-services";
const lease = { id: "slease_one", serviceId: "docling-desk", revision: "a".repeat(64), generation: 1,
  bootEpoch: "daemon-1", expiresAt: "2026-10-06T01:00:00Z", status: "ready" as const, endpoint: "https://knowledge.example" };
test("local service client scopes credentials and tracks the same binding through renew/release", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = new ClientLocalServices({ baseUrl: "https://larm.example/", token: "service-only",
    fetch: (async (url, init) => {
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer service-only");
      expect(init!.redirect).toBe("error");
      const path = new URL(String(url)).pathname;
      requests.push({ path, method: init!.method!, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
      if (path.endsWith("/leases")) expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("intent-1");
      return init!.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(lease);
    }) as typeof fetch,
  });
  const ready = await client.ensure("docling-desk", { idempotencyKey: "intent-1", catalogRevision: lease.revision });
  expect(await client.waitUntilReady(ready)).toEqual(lease);
  await client.renew(ready); await client.release(ready.id);
  expect(requests).toEqual([
    { path: "/v1/local-services/docling-desk/leases", method: "POST", body: { catalogRevision: lease.revision } },
    { path: "/v1/local-service-leases/slease_one/renew", method: "POST", body: { generation: 1, bootEpoch: "daemon-1" } },
    { path: "/v1/local-service-leases/slease_one", method: "DELETE", body: undefined },
  ]);
});
test("service startup polling never repeats ensure or business requests", async () => {
  const requests: string[] = [];
  const client = new ClientLocalServices({ baseUrl: "https://larm.example", token: "scoped",
    fetch: (async (url, init) => { requests.push(`${init!.method} ${url}`); return Response.json(lease); }) as typeof fetch,
  });
  expect((await client.waitUntilReady({ ...lease, endpoint: undefined, status: "starting" })).status).toBe("ready");
  expect(requests).toEqual(["GET https://larm.example/v1/local-service-leases/slease_one"]);
  await expect(client.waitUntilReady({ ...lease, status: "expired" })).rejects.toThrow("expired");
});
test("service client rejects identity changes, replacement generations and oversized responses", async () => {
  let response: unknown = { ...lease, serviceId: "other" };
  const client = new ClientLocalServices({ baseUrl: "https://larm.example", token: "scoped", fetch: (async (_url: Parameters<typeof fetch>[0]) => Response.json(response)) as typeof fetch });
  await expect(client.ensure("docling-desk")).rejects.toThrow("identity mismatch");
  response = { ...lease, generation: 2 };
  await expect(client.renew(lease)).rejects.toThrow("binding changed");
  await expect(client.waitUntilReady({ ...lease, status: "starting", endpoint: undefined })).rejects.toThrow("binding changed");
  response = { ...lease, id: "another" }; await expect(client.resolve(lease.id)).rejects.toThrow("identity mismatch");
  response = { ...lease, endpoint: undefined }; await expect(client.resolve(lease.id)).rejects.toThrow("endpoint");
  response = { large: "x".repeat(131073) }; await expect(client.list()).rejects.toThrow("too large");
});
test("readiness wait does not begin another poll after its deadline", async () => {
  let calls = 0;
  const client = new ClientLocalServices({ baseUrl: "https://larm.example", token: "scoped", fetch: (async (_url: Parameters<typeof fetch>[0]) => { calls++; return Response.json(lease); }) as typeof fetch });
  await expect(client.waitUntilReady({ ...lease, status: "starting", endpoint: undefined }, 0)).rejects.toThrow("starting");
  expect(calls).toBe(0);
});
