import { expect, test } from "bun:test";
import { Hono } from "hono";
import { computeService, computeServiceSchema } from "@larm/core";
import type { AgentConnectionController } from "../agent-connection-controller";
import { registerAgentProfileRoutes } from "./agent-profiles";

function fixture(available: boolean) {
  const configured = computeService("https://stale.example");
  const media = { name: "compute", capability: "image.generate" };
  const body = { services: [media, configured], profiles: [{ id: "test", services: [media, configured] }] };
  const app = new Hono();
  registerAgentProfileRoutes(app, { compute: () => available ? computeService("https://compute.example") : undefined },
    () => ({ listProfilesV3: () => ({ status: 200, body }) }) as unknown as AgentConnectionController,
    (c, result) => c.json(result.body as object));
  return { app, body };
}

test("compute catalog preserves media service names and does not mutate configured services", async () => {
  const { app, body } = fixture(true);
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/v3/agent-profiles");
    const catalog = await response.json() as typeof body;
    expect(catalog.profiles[0]!.services.map(service => service.name)).toEqual(["compute", "compute-python-1"]);
    const service = computeServiceSchema.parse(catalog.profiles[0]!.services[1]);
    expect(service.url).toBe("https://compute.example/v1/compute");
    expect(catalog.services).toEqual(catalog.profiles[0]!.services);
  }
  expect(body.profiles[0]!.services[1]).toEqual(computeService("https://stale.example"));
  expect(body.services[1]).toEqual(computeService("https://stale.example"));
});

test("unavailable compute is not advertised from a configured catalog entry", async () => {
  const { app, body } = fixture(false);
  const response = await app.request("/v3/agent-profiles");
  const catalog = await response.json() as typeof body;
  expect(catalog.profiles[0]!.services).toEqual([{ name: "compute", capability: "image.generate" }]);
  expect(catalog.services).toEqual(catalog.profiles[0]!.services);
  expect(body.profiles[0]!.services).toHaveLength(2);
});
