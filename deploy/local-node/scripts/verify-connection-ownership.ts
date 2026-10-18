import { agentProfileSelectorIdSchema, type AgentProfileSelectorId, type PublicAgentConnection } from "../../../packages/core/src/index";
import { LarmApiError, LarmClient } from "../../../packages/client/src/index";

/** Explicit live verification: may hand over Providers, but never calls inference or edits configuration. */
export async function verifyConnectionOwnership(options: {
  baseUrl: string;
  protectedToken: string;
  backgroundToken: string;
  profile: AgentProfileSelectorId;
  backgroundProfile: AgentProfileSelectorId;
  audience: string;
  providers?: string[];
  onProgress?: (event: Record<string, unknown>) => void;
}) {
  if (!options.protectedToken || !options.backgroundToken || options.protectedToken === options.backgroundToken) {
    throw new Error("distinct authenticated protected and background credentials are required");
  }
  const foreground = new LarmClient({ baseUrl: options.baseUrl, apiToken: options.protectedToken, timeoutMs: 180_000 });
  const background = new LarmClient({ baseUrl: options.baseUrl, apiToken: options.backgroundToken, timeoutMs: 180_000 });
  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/openapi.json`, {
    headers: { authorization: `Bearer ${options.protectedToken}` }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OpenAPI preflight failed (${response.status})`);
  const api = await response.json() as { paths?: Record<string, unknown> };
  if (!api.paths?.["/v1/agent-connections/{id}/ownership"]) throw new Error("running daemon does not implement Connection ownership");
  const health = await foreground.getHealth();
  const marker = crypto.randomUUID();
  const ownershipId = crypto.randomUUID();
  let held: PublicAgentConnection | undefined, worker: PublicAgentConnection | undefined;
  const workerRequest = { profile: options.backgroundProfile, audience: options.audience, client: `ownership-background-${marker}`,
    providers: options.providers, ttlSeconds: 300 };
  try {
    held = await foreground.createAgentConnection({ profile: options.profile, audience: options.audience,
      providers: options.providers, client: `ownership-screen-${marker}`, ttlSeconds: 300,
      ownership: { id: ownershipId, issuedAt: new Date().toISOString() } });
    let sequence = 0;
    let renewed = false;
    let lastHeartbeat = performance.now();
    const preparationDeadline = lastHeartbeat + 180_000;
    while (held.status === "pending" || held.status === "probing") {
      if (performance.now() >= preparationDeadline) throw new Error("foreground readiness timed out");
      await Bun.sleep(1000);
      if (performance.now() - lastHeartbeat >= 30_000) {
        held = await foreground.refreshAgentConnectionOwnership(held.id, ownershipId, ++sequence);
        lastHeartbeat = performance.now();
      }
      if (Date.parse(held.expiresAt) - Date.now() < 90_000) {
        held = await foreground.renewAgentConnection(held.id, 300);
      }
      held = await foreground.getAgentConnection(held.id);
    }
    if (held.status !== "ready") throw new Error("foreground preparation failed");
    const initialClaim = await foreground.claimAgentConnection(held.id);
    const quietStartedAt = new Date().toISOString();
    const started = performance.now();
    while (performance.now() - started < 360_000) {
      await Bun.sleep(30_000);
      if (Date.parse(held.expiresAt) - Date.now() < 90_000) {
        // Reclaim uses semantic readiness and may run an inference probe. Keep
        // the measured six-minute quiet interval free of those probes as well.
        held = await foreground.renewAgentConnection(held.id, 300);
        renewed = true;
      }
      held = await foreground.refreshAgentConnectionOwnership(held.id, ownershipId, ++sequence);
      if (held.status !== "ready" || held.ownership?.state !== "active") throw new Error("foreground ownership was lost");
      try {
        worker = await background.createAgentConnection(workerRequest);
        throw new Error("background acquired a Connection during active foreground ownership");
      } catch (error) {
        if (!(error instanceof LarmApiError) || error.status !== 409 || error.code !== "foreground_protected") throw error;
      }
      options.onProgress?.({ elapsedSeconds: Math.floor((performance.now() - started) / 1000), sequence,
        foregroundStatus: held.status, background: "foreground_protected", renewed });
    }
    const quietEndedAt = new Date().toISOString();
    if (!renewed) throw new Error("credential renewal boundary was not crossed");
    const refreshedClaim = await foreground.claimAgentConnection(held.id);
    if (refreshedClaim.expiresAt !== held.expiresAt || refreshedClaim.providers[0]?.credential.token === initialClaim.providers[0]?.credential.token) {
      throw new Error("reclaimed provider credential did not rotate with renewal");
    }
    held = await foreground.refreshAgentConnectionOwnership(held.id, ownershipId, ++sequence);
    if (held.status !== "ready" || held.ownership?.state !== "active") throw new Error("reclaim changed foreground ownership");
    await foreground.releaseAgentConnectionOwnership(held.id, ownershipId);
    try {
      await foreground.refreshAgentConnectionOwnership(held.id, ownershipId, ++sequence);
      throw new Error("released ownership was revived by a delayed heartbeat");
    } catch (error) {
      if (!(error instanceof LarmApiError) || ![409, 410].includes(error.status)) throw error;
    }
    worker = await background.createAgentConnection(workerRequest);
    worker = await background.waitForAgentConnection(worker, { timeoutMs: 180_000, pollIntervalMs: 1000 });
    return { result: "passed", releaseCommit: health.releaseCommit, bootEpoch: health.bootEpoch,
      elapsedSeconds: Math.floor((performance.now() - started) / 1000), renewed,
      foregroundConnectionId: held.id, backgroundConnectionId: worker.id,
      consumerInferenceRequests: 0, quietStartedAt, quietEndedAt, credentialRotated: true, backgroundAfterRelease: worker.status };
  } finally {
    if (held) await foreground.releaseAgentConnection(held.id).catch(() => undefined);
    if (worker) await background.releaseAgentConnection(worker.id).catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    const profile = agentProfileSelectorIdSchema.parse(process.env.LARM_OWNERSHIP_PROFILE);
    const backgroundProfile = agentProfileSelectorIdSchema.parse(process.env.LARM_OWNERSHIP_BACKGROUND_PROFILE);
    const audience = process.env.LARM_OWNERSHIP_AUDIENCE;
    if (!audience) throw new Error("LARM_OWNERSHIP_AUDIENCE is required");
    const result = await verifyConnectionOwnership({
      baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
      protectedToken: process.env.LARM_PROTECTED_CONSUMER_TOKEN ?? "",
      backgroundToken: process.env.LARM_API_TOKEN ?? "",
      profile, backgroundProfile, audience,
      providers: process.env.LARM_OWNERSHIP_PROVIDERS?.split(","),
      onProgress: event => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never serialize a response body or credentials to verification output.
    console.error(error instanceof LarmApiError ? `ownership verification failed: ${error.status} ${error.code}`
      : error instanceof Error ? error.message : "ownership verification failed");
    process.exitCode = 1;
  }
}
