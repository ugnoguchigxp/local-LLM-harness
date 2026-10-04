import { expect, test } from "bun:test";
import { runContextStillSmoke } from "./smoke-contextstill-profile";
import type { AgentHttpSmokeFetch } from "./smoke-agent-http";

const releaseCommit = "a".repeat(40);
const configRevision = "b".repeat(64);

function fixture(options: { busy?: boolean; staleRelease?: boolean } = {}) {
  const paths: string[] = [];
  const fetch: AgentHttpSmokeFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    paths.push(url.pathname);
    if (url.pathname === "/health") return Response.json({
      status: "ok", version: "0.1.0", releaseCommit: options.staleRelease ? "c".repeat(40) : releaseCommit,
      configRevision, bootEpoch: "epoch", ready: true,
    });
    if (url.pathname === "/v1/activity") return Response.json({
      contractVersion: "larm-service-activity.v1", state: options.busy ? "active" : "idle",
      activeWorkloads: options.busy ? 1 : 0, observedAt: new Date().toISOString(), validForMs: 1000,
      retryAfterMs: options.busy ? 1000 : 0, reservationGuaranteed: false, bootEpoch: "epoch", configRevision,
    });
    if (url.pathname === "/v3/agent-profiles") return Response.json({
      contractVersion: "agent-connection.v3", catalogRevision: configRevision, defaultAgentProfile: "coding-default",
      requestedProfile: "contextStill", audiences: ["same-host"], profiles: [{
        id: "contextstill-background", canonicalProfile: "contextstill-background", description: "legacy",
        selectionPolicy: "explicit-only", deprecated: false, services: [], providers: [{
          name: "llm", capability: "llm.coding", supportedCapabilities: ["llm.coding"],
          protocol: "openai.chat-completions.v1", endpoint: "/v1/chat/completions", model: "qwen-agent-worker",
        }],
      }],
    });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  return { fetch, paths };
}

test("ContextStill canary rejects the old Qwen-only discovery before allocating", async () => {
  const f = fixture();
  await expect(runContextStillSmoke({ baseUrl: "http://larm.test", apiToken: "test", expectedReleaseCommit: releaseCommit,
    fetch: f.fetch })).rejects.toThrow("Provider catalog drift");
  expect(f.paths).toEqual(["/health", "/v1/activity", "/v3/agent-profiles"]);
});

test("ContextStill canary does not compete with an existing workload", async () => {
  const f = fixture({ busy: true });
  await expect(runContextStillSmoke({ baseUrl: "http://larm.test", apiToken: "test", expectedReleaseCommit: releaseCommit,
    fetch: f.fetch })).rejects.toThrow("must be idle");
  expect(f.paths).toEqual(["/health", "/v1/activity"]);
});

test("ContextStill canary rejects a different deployed release before allocating", async () => {
  const f = fixture({ staleRelease: true });
  await expect(runContextStillSmoke({ baseUrl: "http://larm.test", apiToken: "test", expectedReleaseCommit: releaseCommit,
    fetch: f.fetch })).rejects.toThrow("identity/readiness mismatch");
  expect(f.paths).toEqual(["/health"]);
});
