import type { ClusterState, Registry } from "@larm/core";
import type { Hono } from "hono";
import type { ControlPlane } from "../controller";
import { errorBody, inspectionRuntime, publicClusterState, publicRuntime } from "../app-http";

export type InspectionRouteDeps = {
  registry: Registry;
  getState: () => ClusterState;
  control: ControlPlane;
};

export function registerInspectionRoutes(app: Hono, deps: InspectionRouteDeps): void {
  app.get("/runtimes", (c) => c.json({
    runtimes: deps.registry.runtimes.map(publicRuntime),
  }));

  app.get("/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(publicRuntime(runtime));
  });

  app.get("/state", (c) => c.json(publicClusterState(deps.getState())));

  app.get("/v1/inspection/runtimes", (c) => c.json({
    runtimes: deps.registry.runtimes.map(inspectionRuntime),
  }));

  app.get("/v1/inspection/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(inspectionRuntime(runtime));
  });

  app.get("/v1/inspection/state", (c) => c.json(deps.getState()));
  app.get("/v1/inspection/provider-instances", (c) => c.json({
    instances: deps.control.getProviderInstances(),
  }));

  const operation = (id: string) => {
    const found = deps.control.getOperation(id);
    return found ?? null;
  };
  app.get("/operations/:id", (c) => {
    const found = operation(c.req.param("id"));
    if (!found) return c.json(errorBody("not_found", "operation not found"), 404);
    return c.json(found);
  });
  app.get("/v1/operations/:id", (c) => {
    const found = operation(c.req.param("id"));
    if (!found) return c.json(errorBody("not_found", "operation not found"), 404);
    return c.json(found);
  });
}
