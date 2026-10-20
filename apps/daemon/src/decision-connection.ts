import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { agentConnectionClaimSchema, publicAgentConnectionSchema, systemOneResponseSchema, type AgentConnectionClaim } from "@larm/core";
import { DecisionError, type DecisionSession } from "./decision-manager";

/** Training uses an idle-only profile. Reconnect after foreground preemption and retry the current example. */
export async function openDecisionSession(app: Hono, token: string, onPhase?: (phase: string) => void): Promise<DecisionSession> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const deadline = Date.now() + 30 * 60 * 1000;
  let id: string | undefined;
  let provider: Extract<AgentConnectionClaim["providers"][number], { apiStyle: "larm-system-one" }> | undefined;
  const close = async () => {
    if (id) await app.request(`/v1/agent-connections/${id}`, { method: "DELETE", headers });
    id = undefined; provider = undefined;
  };
  const wait = async () => { onPhase?.("waiting_for_idle"); await close(); await Bun.sleep(1000); };
  const checkDeadline = () => { if (Date.now() >= deadline) throw new DecisionError("decision_job_timeout", 503); };
  return { close, predict: async body => {
    while (true) {
      checkDeadline();
      try {
        if (!provider) {
          const response = await app.request("/v1/agent-connections", {
            method: "POST", headers: { ...headers, "idempotency-key": randomUUID() },
            body: JSON.stringify({ profile: "decisionTraining", audience: "same-host", client: `training-${randomUUID()}`, providers: ["decision"], ttlSeconds: 3600 }),
          });
          if (response.status === 409) { await wait(); continue; }
          if (!response.ok) throw new DecisionError("decision_provider_unavailable", 503);
          let connection = publicAgentConnectionSchema.parse(await response.json()); id = connection.id;
          const readyDeadline = Math.min(deadline, Date.now() + 300_000);
          while (connection.status !== "ready" && !["failed", "released", "expired"].includes(connection.status)) {
            if (Date.now() >= readyDeadline) throw new DecisionError("decision_provider_unavailable", 503);
            await Bun.sleep(100);
            const status = await app.request(`/v1/agent-connections/${id}`, { headers });
            if (!status.ok) throw new DecisionError("decision_provider_unavailable", 503);
            connection = publicAgentConnectionSchema.parse(await status.json());
          }
          if (connection.status !== "ready") {
            const failure = connection.error?.code;
            if (failure === "foreground_preempted") { await wait(); continue; }
            throw new DecisionError("decision_provider_unavailable", 503);
          }
          const claimed = await app.request(`/v1/agent-connections/${id}/claim`, { method: "POST", headers, body: JSON.stringify({ format: "openai-provider-v1" }) });
          if (claimed.status === 409) { await wait(); continue; }
          if (!claimed.ok) throw new DecisionError("decision_provider_unavailable", 503);
          const claim = agentConnectionClaimSchema.parse(await claimed.json());
          const selected = claim.providers.find(p => p.capability === "decision.general");
          if (!selected || selected.apiStyle !== "larm-system-one") throw new DecisionError("decision_provider_unavailable", 503);
          provider = selected;
        }
        onPhase?.("features");
        const result = await app.request(provider.endpoint, { method: "POST", headers: {
          authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json",
        }, body: JSON.stringify(body) });
        if ([401, 409, 429].includes(result.status)) { await result.body?.cancel(); await wait(); continue; }
        if (!result.ok) {
          const error = await result.json().catch(() => ({})) as { error?: { code?: string } };
          const code = error.error?.code;
          if (code === "foreground_preempted" || code === "allocation_released") { await wait(); continue; }
          throw new DecisionError(code && /^[a-z0-9_]{1,100}$/.test(code) ? code : "decision_feature_request_failed", 503);
        }
        return systemOneResponseSchema.parse(await result.json());
      } catch (error) { await close(); throw error; }
    }
  } };
}
