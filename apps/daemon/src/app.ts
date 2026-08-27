import type { ClusterState, Registry } from "@larm/core";
import {
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
} from "@larm/core";
import { Hono } from "hono";
import type { ControlPlane } from "./controller";

export type AppDeps = {
  registry: Registry;
  getState: () => ClusterState;
  control: ControlPlane;
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function publicRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    backend: runtime.backend,
    node: runtime.node,
    policy: runtime.policy,
    resources: runtime.resources,
    deployment: runtime.deployment,
  };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/runtimes", (c) =>
    c.json({
      runtimes: deps.registry.runtimes.map(publicRuntime),
    }),
  );

  app.get("/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(publicRuntime(runtime));
  });

  app.get("/state", (c) => c.json(deps.getState()));

  app.get("/operations/:id", (c) => {
    const operation = deps.control.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "operation not found"), 404);
    }
    return c.json(operation);
  });

  app.post("/prepare", async (c) => {
    const parsed = prepareRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "profile or capabilities is required"), 400);
    }
    const result = await deps.control.prepare(parsed.data);
    return c.json(result.body, result.status as 200 | 202 | 400 | 404 | 409);
  });

  app.post("/release", async (c) => {
    const parsed = releaseRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "leaseId is required"), 400);
    }
    const result = await deps.control.release(parsed.data.leaseId);
    return c.json(result.body, result.status as 200 | 404);
  });

  app.post("/resolve", async (c) => {
    const parsed = resolveRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = deps.control.resolve(parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 503);
  });

  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  return app;
}
