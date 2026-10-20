import type { Hono } from "hono";
import { ComputeError } from "@larm/core";
import { createHash } from "node:crypto";
import { COMPUTE_LIMITS } from "@larm/core";
import type { ComputeManager } from "../compute/manager";
import { secretMatches } from "../app-auth";
import { readBodyLimited, RequestBodyError } from "../http-body";

export function registerComputeRoutes(app: Hono, options: { manager?: ComputeManager; apiToken?: string; protectedToken?: string }) {
  app.use("/v1/compute/*", async (c, next) => {
    c.header("cache-control", "no-store");
    try {
      if (!options.apiToken) throw new ComputeError("unavailable", "Control authentication is not configured", 503);
      if (!secretMatches(c.req.header("authorization"), `Bearer ${options.apiToken}`)
        && !(options.protectedToken && secretMatches(c.req.header("authorization"), `Bearer ${options.protectedToken}`))) {
        throw new ComputeError("unauthorized", "Control Bearer is required", 401);
      }
      if (!options.manager) throw new ComputeError("unavailable", "CPU compute is not configured", 503);
      await next();
    } catch (error) {
      const failure = error instanceof ComputeError ? error : error instanceof RequestBodyError
        ? new ComputeError(error.status === 413 ? "limit_exceeded" : "invalid_request", "Invalid compute request body")
        : new ComputeError("unavailable", "Calculation service could not process the request", 503);
      if (failure.status === 429 || failure.status === 503) c.header("retry-after", "5");
      return c.json({ error: { code: failure.code, message: failure.message } }, failure.status);
    }
  });
  const manager = () => options.manager!;
  const principal = (authorization: string) => createHash("sha256").update(authorization).digest("hex");
  app.get("/v1/compute/environment", c => c.json(manager().environment()));
  app.post("/v1/compute/jobs", async c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) throw new ComputeError("invalid_request", "application/json is required");
    const bytes = await readBodyLimited(c.req.raw, COMPUTE_LIMITS.maxRequestBytes, c.req.raw.signal).catch(error => {
      throw new ComputeError(error instanceof RequestBodyError && error.status === 413 ? "limit_exceeded" : "invalid_request", "Invalid compute request body");
    });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ComputeError("invalid_request", "Valid UTF-8 JSON is required"); }
    const receipt = manager().submit(body, principal(c.req.header("authorization")!), c.req.header("idempotency-key") ?? "");
    c.header("location", `/v1/compute/jobs/${receipt.jobId}`); c.header("retry-after", "1");
    return c.json(receipt, 202);
  });
  app.get("/v1/compute/jobs/:id", c => c.json(manager().get(c.req.param("id"), principal(c.req.header("authorization")!))));
  app.post("/v1/compute/jobs/:id/cancel", async c => {
    const job = await manager().cancel(c.req.param("id"), principal(c.req.header("authorization")!));
    return c.json(job, job.cancelRequested ? 202 : 200);
  });
  app.delete("/v1/compute/jobs/:id", async c => {
    const job = await manager().delete(c.req.param("id"), principal(c.req.header("authorization")!));
    return job ? c.json(job, job.cancelRequested ? 202 : 200) : c.body(null, 204);
  });
  app.get("/v1/compute/jobs/:id/artifacts/:artifactId", c => {
    const artifact = manager().artifact(c.req.param("id"), c.req.param("artifactId"), principal(c.req.header("authorization")!));
    c.header("content-type", artifact.mime); c.header("content-length", String(artifact.bytes));
    c.header("content-disposition", `attachment; filename="${artifact.id}"`);
    c.header("x-content-type-options", "nosniff"); c.header("content-security-policy", "sandbox; default-src 'none'");
    return c.body(new Uint8Array(artifact.data));
  });
}
