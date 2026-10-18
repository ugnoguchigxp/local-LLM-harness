/** Acceptance against the existing daemon and ordinary consumer credential. No inference is sent. */
const base = process.env.LARM_BASE_URL;
const token = process.env.LARM_API_TOKEN;
if (!base || !token) throw new Error("LARM_BASE_URL and the existing LARM_API_TOKEN are required");
const root = base.replace(/\/$/, "");
const durationMs = Number(process.env.LARM_VERIFY_DURATION_MS ?? 360_000);
if (durationMs < 360_000) throw new Error("acceptance requires at least six minutes");
const profile = process.env.LARM_VERIFY_PROFILE ?? "ornith1.5Strix";
const audience = process.env.LARM_VERIFY_AUDIENCE ?? "saaa-desktop";
const client = `eumenes-demand-e2e-${crypto.randomUUID()}`;
const owned = new Set<string>();
const samples: Record<string, unknown>[] = [];
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const emit = (event: string, data: Record<string, unknown> = {}) => {
  const sample = { event, at: new Date().toISOString(), ...data }; samples.push(sample); console.log(JSON.stringify(sample));
};
async function inferenceCounters(): Promise<Record<string, number> | undefined> {
  const metricsUrl = process.env.LARM_VERIFY_METRICS_URL;
  if (!metricsUrl) return undefined;
  const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, "resolved Provider metrics unavailable");
  const counters: Record<string, number> = {};
  for (const line of (await response.text()).split("\n")) {
    const match = /^(llamacpp:(?:prompt_tokens_total|tokens_predicted_total)) (\d+(?:\.\d+)?)$/.exec(line);
    if (match) counters[match[1]!] = Number(match[2]);
  }
  assert(Object.keys(counters).length === 2, "inference counters unavailable");
  return counters;
}
const payload = (value: string) => JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString()) as { generation: number; exp: number };
type Connection = { id: string; allocationId: string; status: string; expiresAt: string; idleReleaseAt?: string; error?: { code: string } };
async function request(path: string, method = "GET", body?: unknown, key?: string) {
  const response = await fetch(`${root}${path}`, { method, headers: { ...headers, ...(key ? { "idempotency-key": key, prefer: "wait=1" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
  const data = response.status === 204 ? undefined : await response.json();
  return { response, data };
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const catalogResponse = await request("/v3/agent-profiles");
assert(catalogResponse.response.status === 200, "the existing profile catalog is unavailable");
const expectedCatalogRevision = (catalogResponse.data as { catalogRevision: string }).catalogRevision;
const input = { profile, client, audience, expectedCatalogRevision, ttlSeconds: 900, allowFallback: false, deploymentPolicy: "existing-only", providers: ["llm"] };
async function demand(key: string, body: unknown = input): Promise<Connection> {
  const { response, data } = await request("/v1/agent-connections", "POST", body, key);
  assert(response.status === 201 || response.status === 202, `demand rejected: ${response.status} ${JSON.stringify(data)}`);
  const connection = data as Connection;
  owned.add(connection.id);
  return connection;
}
try {
  const unauthenticated = await fetch(`${root}/v1/agent-connections`, { method: "POST", headers: { authorization: "Bearer invalid-demand-acceptance-credential", "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(input) });
  assert(unauthenticated.status === 401, "this acceptance requires the existing authenticated endpoint");
  await unauthenticated.body?.cancel();
  let connection = await demand(crypto.randomUUID());
  const prepareDeadline = Date.now() + 90_000;
  while (connection.status !== "ready" && Date.now() < prepareDeadline) {
    assert(!["failed", "released", "expired"].includes(connection.status), `preparation failed: ${connection.status}`);
    await Bun.sleep(1_000);
    connection = (await request(`/v1/agent-connections/${connection.id}`)).data as Connection;
  }
  assert(connection.status === "ready" && connection.idleReleaseAt, "connection did not become ready with an idle deadline");
  const first = connection;
  emit("acquired", { ...connection, baseUrl: root, profile, audience, client });
  const initialClaim = (await request(`/v1/agent-connections/${first.id}/claim`, "POST", { format: "openai-provider-v1" })).data as {
    providers: { credential: { token: string }; health: { url: string } }[];
  };
  const initialProvider = initialClaim.providers[0]!;
  const originalCredential = payload(initialProvider.credential.token);
  const beforeInference = await inferenceCounters();
  let credentialRenewed = false;
  const heldAt = Date.now();
  let key = "";
  while (true) {
    await Bun.sleep(30_000);
    const previous = connection;
    key = crypto.randomUUID();
    connection = await demand(key);
    assert(connection.id === first.id && connection.allocationId === first.allocationId, "connection or allocation was replaced");
    assert(connection.status === "ready", "connection lost readiness");
    assert(Date.parse(connection.idleReleaseAt!) > Date.parse(previous.idleReleaseAt!), "new demand did not advance the actual idle deadline");
    assert(Date.parse(connection.expiresAt) > Date.parse(previous.expiresAt), "new demand did not advance allocation expiry");
    const competitor = await request("/v1/agent-connections", "POST", { ...input, profile: "contextStill", client: `${client}-contextstill` }, crypto.randomUUID());
    if (competitor.response.status === 201 || competitor.response.status === 202) owned.add((competitor.data as Connection).id);
    assert(competitor.response.status === 409 && (competitor.data as { error: { code: string } }).error.code === "provider_conflict", "ContextStill acquired during foreground occupancy");
    if (!credentialRenewed && Date.now() - heldAt >= 240_000) {
      const renewed = await request(`/v1/agent-connections/${first.id}/renew`, "POST", { ttlSeconds: 900 }, crypto.randomUUID());
      assert(renewed.response.status === 200, "existing renew failed");
      // A revoked token is rejected before semantic readiness, without a probe.
      const revoked = await fetch(initialProvider.health.url, { headers: { authorization: `Bearer ${initialProvider.credential.token}` }, signal: AbortSignal.timeout(5_000) });
      assert(revoked.status === 401, "explicit renew did not revoke the previous credential");
      await revoked.body?.cancel();
      emit("credential_renewed", { revokedCredentialStatus: revoked.status });
      credentialRenewed = true;
    }
    emit("refreshed", { id: connection.id, allocationId: connection.allocationId, idleReleaseAt: connection.idleReleaseAt, expiresAt: connection.expiresAt, heldSeconds: (Date.now() - heldAt) / 1_000, competitorStatus: competitor.response.status });
    if (Date.now() - heldAt >= durationMs) break;
  }
  const afterInference = await inferenceCounters();
  emit("idle_inference_counters", { before: beforeInference, after: afterInference });
  assert(JSON.stringify(beforeInference) === JSON.stringify(afterInference), "Provider inference counters changed during the idle window");
  // Claim deliberately follows the quiet window: its existing contract may
  // perform a semantic inference probe once the readiness cache has expired.
  const claim = await request(`/v1/agent-connections/${first.id}/claim`, "POST", { format: "openai-provider-v1" });
  assert(claim.response.status === 200, "claim after explicit renew failed");
  const updatedCredential = payload((claim.data as typeof initialClaim).providers[0]!.credential.token);
  assert(updatedCredential.generation === originalCredential.generation + 1 && updatedCredential.exp > originalCredential.exp,
    "POST rotated credentials or explicit renew/claim did not update credential expiry");
  emit("credential_updated", { generationBefore: originalCredential.generation, generationAfter: updatedCredential.generation,
    expiresAt: new Date(updatedCredential.exp * 1_000).toISOString() });
  const deadline = connection.idleReleaseAt!;
  const stoppedAt = Date.now();
  const replay = await demand(key);
  assert(replay.idleReleaseAt === deadline, "replayed key advanced the idle deadline");
  emit("requests_stopped", { id: connection.id, idleReleaseAt: deadline, heldSeconds: (stoppedAt - heldAt) / 1_000 });
  const releaseLimit = Date.parse(deadline) + 30_000;
  while (Date.now() < releaseLimit) {
    await Bun.sleep(Math.min(5_000, Math.max(50, Date.parse(deadline) - Date.now() + 100)));
    const current = (await request(`/v1/agent-connections/${connection.id}`)).data as Connection;
    if (current.status === "released") {
      assert(current.error?.code === "foreground_idle_timeout", "release was not caused by the configured idle timeout");
      connection = current; break;
    }
    assert(current.status === "ready" && current.idleReleaseAt === deadline, "GET polling changed occupancy or connection was interrupted");
  }
  assert(connection.status === "released", "automatic release did not occur");
  emit("automatically_released", { id: connection.id, secondsAfterStop: (Date.now() - stoppedAt) / 1_000, deadline });
  const delayed = await demand(key);
  assert(delayed.id === first.id, "cached replay changed the connection");
  assert(((await request(`/v1/agent-connections/${first.id}`)).data as Connection).status === "released", "delayed replay resurrected the connection");
  let competitor = await demand(crypto.randomUUID(), { ...input, profile: "contextStill", client: `${client}-contextstill` });
  const backgroundReadyLimit = Date.now() + 180_000;
  while (competitor.status !== "ready" && Date.now() < backgroundReadyLimit) {
    assert(!["failed", "released", "expired"].includes(competitor.status), `background preparation failed: ${competitor.status}`);
    await Bun.sleep(1_000);
    competitor = (await request(`/v1/agent-connections/${competitor.id}`)).data as Connection;
  }
  assert(competitor.status === "ready", "ContextStill did not acquire a ready Provider after foreground release");
  emit("background_acquired", { id: competitor.id, status: competitor.status });
  emit("passed", { connectionId: first.id, inferenceRequestsSent: 0 });
} finally {
  for (const id of owned) {
    const { response } = await request(`/v1/agent-connections/${id}`, "DELETE");
    emit("cleanup", { id, status: response.status });
    assert(response.status === 204, "test connection cleanup failed");
  }
}
export {};
