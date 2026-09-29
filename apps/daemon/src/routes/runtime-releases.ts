import {
  runtimeReleasePlanRequestSchema,
  runtimeReleaseSelectionSchema,
} from "@larm/core";
import type { Hono } from "hono";
import { RuntimeReleaseManager, RuntimeReleaseManagerError } from "../runtime-release-manager";
import { errorBody, readJson } from "../app-http";

export function registerRuntimeReleaseRoutes(
  app: Hono,
  deps: { runtimeReleaseManager?: RuntimeReleaseManager; controlMaxBodyBytes: number },
): void {
  app.get("/v1/runtime-releases", (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    return c.json({ releases: deps.runtimeReleaseManager.listPublicReleases() });
  });

  app.post("/v1/runtime-releases/:id/stage", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.stageRelease(c.req.param("id")), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        return c.json(errorBody(error.code, error.message), 404);
      }
      throw error;
    }
  });

  app.get("/v1/deployments/:runtime", (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(deps.runtimeReleaseManager.getDeployment(c.req.param("runtime")));
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        return c.json(errorBody(error.code, error.message), 404);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/plan", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    const parsed = runtimeReleasePlanRequestSchema.safeParse(await readJson(c, deps.controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid runtime release selection"), 400);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.plan(c.req.param("runtime"), parsed.data.release));
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "release_not_found" || error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/activate", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    const parsed = runtimeReleaseSelectionSchema.safeParse(await readJson(c, deps.controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid runtime release selection"), 400);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.activate(
        c.req.param("runtime"),
        parsed.data.release,
        parsed.data.expectedActiveRelease,
      ), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "release_not_found" || error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/rollback", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.rollback(c.req.param("runtime")), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });
}
