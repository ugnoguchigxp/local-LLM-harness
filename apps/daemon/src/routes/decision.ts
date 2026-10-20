import type { Hono } from "hono";
import { decisionTrainingRequestSchema } from "@larm/core";
import { DecisionError, type DecisionManager } from "../decision-manager";
import { readBodyLimited } from "../http-body";
import { errorBody, readJson } from "../app-http";
import { secretMatches } from "../app-auth";

export function registerDecisionRoutes(app: Hono, options: { manager?: DecisionManager; apiToken?: string }) {
  app.use("/v1/decision/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (!options.apiToken) return c.json(errorBody("decision_auth_not_configured", "Control Bearer is required"), 503);
    if (!secretMatches(c.req.header("authorization"), `Bearer ${options.apiToken}`)) return c.json(errorBody("unauthorized", "Control Bearer is required"), 401);
    if (!options.manager) return c.json(errorBody("decision_not_configured", "decision training is not configured"), 503);
    try { await next(); } catch (error) {
      if (error instanceof DecisionError) return c.json(errorBody(error.code, error.code), error.status);
      throw error;
    }
  });
  const manager = () => options.manager!;
  app.post("/v1/decision/datasets", async c => {
    let text: string;
    const bytes = await readBodyLimited(c.req.raw, 8 * 1024 * 1024);
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DecisionError("decision_invalid_dataset"); }
    return c.json(manager().upload(text, c.req.header("idempotency-key") ?? ""), 201);
  });
  app.get("/v1/decision/datasets", c => c.json({ datasets: manager().listDatasets() }));
  app.get("/v1/decision/datasets/:id", c => {
    const d = manager().getDataset(c.req.param("id"));
    if (!d) throw new DecisionError("decision_dataset_not_found", 404);
    return c.json(d);
  });
  app.delete("/v1/decision/datasets/:id", c => c.json(manager().deleteDataset(c.req.param("id"), c.req.header("idempotency-key") ?? "")));
  app.post("/v1/decision/training-jobs", async c => {
    const parsed = decisionTrainingRequestSchema.safeParse(await readJson(c, 512 * 1024));
    if (!parsed.success) throw new DecisionError("decision_invalid_training_request");
    const job = manager().create(parsed.data, c.req.header("idempotency-key") ?? "");
    c.header("location", `/v1/decision/training-jobs/${job.jobId}`); c.header("retry-after", "1");
    return c.json(job, 202);
  });
  app.get("/v1/decision/training-jobs/:id", c => {
    const j = manager().getJob(c.req.param("id"));
    if (!j) throw new DecisionError("decision_job_not_found", 404);
    return c.json(j);
  });
  app.get("/v1/decision/adapters", c => c.json({ adapters: manager().listAdapters() }));
  app.get("/v1/decision/adapters/:id/versions/:version", c => {
    const a = manager().getAdapter(c.req.param("id"), Number(c.req.param("version")));
    if (!a) throw new DecisionError("decision_adapter_not_found", 404);
    return c.json(a);
  });
  app.delete("/v1/decision/adapters/:id/versions/:version", c => c.json(manager().deleteAdapter(c.req.param("id"), Number(c.req.param("version")), c.req.header("idempotency-key") ?? "")));
}
