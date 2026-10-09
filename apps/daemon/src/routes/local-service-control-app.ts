import { Hono } from "hono";
import { z } from "zod";
import { LocalServiceError } from "../local-service-manager";
import { registerLocalServiceRoutes } from "./local-services";

/** The existing scoped control routes, assembled for isolated live acceptance. */
export function createLocalServiceControlApp(options: Parameters<typeof registerLocalServiceRoutes>[1]) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof LocalServiceError) return c.json({ error: { code: error.code } }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: { code: "invalid_input" } }, 400);
    return c.json({ error: { code: "local_service_failed" } }, 503);
  });
  registerLocalServiceRoutes(app, options);
  return app;
}
