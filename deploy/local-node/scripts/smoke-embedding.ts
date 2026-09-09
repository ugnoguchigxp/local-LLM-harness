import { LarmApiError, LarmClient, type EmbeddingAgentProvider } from "../../../packages/client/src/index";

export type EmbeddingSmokeResult = {
  ok: true;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
  catalogRevision: string;
  profile: string;
  provider: string;
  model: string;
  modelId: string;
  modelRevision: string;
  artifactDigest: string;
  dimension: number;
  normalization: "l2";
  queryNorm: number;
  passageNorm: number;
  capacity: EmbeddingAgentProvider["capacity"];
  initialActivity: string;
  finalActivity: string;
  renewed: true;
  oldCredentialRevoked: true;
  released: true;
  releasedCredentialRevoked: true;
};

function norm(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

async function expectRevoked(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof LarmApiError && error.status === 401) return;
    throw error;
  }
  throw new Error("provider credential remained usable after lifecycle invalidation");
}

export async function runEmbeddingSmoke(options: {
  baseUrl: string;
  apiToken?: string;
  expectedReleaseCommit?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<EmbeddingSmokeResult> {
  const client = new LarmClient({
    baseUrl: options.baseUrl,
    ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    timeoutMs: options.timeoutMs ?? 180_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const health = await client.getHealth();
  if (health.releaseCommit === "development") throw new Error("live release identity is development");
  if (options.expectedReleaseCommit && health.releaseCommit !== options.expectedReleaseCommit) {
    throw new Error(`release drift: expected ${options.expectedReleaseCommit}, got ${health.releaseCommit}`);
  }
  if ((await client.getReadiness()).status !== "ready") throw new Error("LARM is not ready");
  const initialActivity = await client.getServiceActivity();
  if (initialActivity.state === "draining") throw new Error("LARM is draining");
  const profiles = await client.listAgentProfilesV3();
  if (profiles.catalogRevision !== health.configRevision) {
    throw new Error("embedding catalog and daemon configuration revisions differ");
  }
  const profile = profiles.profiles.find((candidate) => candidate.id === "contextstill-embedding");
  const advertised = profile?.providers.find((candidate) => candidate.name === "embedding");
  if (!profile || profile.selectionPolicy !== "explicit-only" || !advertised?.embeddingSpace) {
    throw new Error("contextstill-embedding is not advertised as an explicit embedding profile");
  }
  const space = advertised.embeddingSpace;
  if (
    advertised.protocol !== "larm.embedding.v1"
    || advertised.model !== "multilingual-e5-small"
    || space.model.id !== "intfloat/multilingual-e5-small"
    || space.model.revision !== "614241f622f53c4eeff9890bdc4f31cfecc418b3"
    || space.dimension !== 384
    || space.prefixes.query !== "query: "
    || space.prefixes.passage !== "passage: "
    || space.normalization !== "l2"
    || space.tokenization.maxTokens !== 512
    || space.tokenization.truncation !== "end"
  ) throw new Error("advertised embedding semantic space drifted from the commissioned contract");

  const created = await client.createAgentConnection({
    agentProfile: profile.id,
    explicitAgentProfile: true,
    audience: "same-host",
    client: "embedding-canary",
    ttlSeconds: 120,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  });
  let released = false;
  try {
    const ready = await client.waitForAgentConnection(created, { timeoutMs: options.timeoutMs ?? 180_000 });
    const providerHealth = await client.getAgentConnectionHealth(ready.id);
    if (!providerHealth.ready || !providerHealth.acceptingRequests) {
      throw new Error("embedding provider is not accepting requests");
    }
    const firstClaim = await client.claimAgentConnection(ready.id, "larm-embedding-provider-v1");
    const firstProvider = firstClaim.providers[0];
    if (!firstProvider || firstProvider.apiStyle !== "larm-embedding") {
      throw new Error("claim did not return an embedding provider");
    }
    const query = await client.embed(firstProvider, {
      texts: ["semantic readiness"],
      type: "query",
      normalize: true,
      priority: "low",
    });
    await client.renewAgentConnection(ready.id, 120);
    const renewedClaim = await client.claimAgentConnection(ready.id, "larm-embedding-provider-v1");
    const renewedProvider = renewedClaim.providers[0];
    if (!renewedProvider || renewedProvider.apiStyle !== "larm-embedding") {
      throw new Error("renewed claim did not return an embedding provider");
    }
    await expectRevoked(() => client.embed(firstProvider, {
      texts: ["revocation check"],
      type: "query",
      normalize: true,
      priority: "low",
    }));
    const passage = await client.embed(renewedProvider, {
      texts: ["semantic readiness document"],
      type: "passage",
      normalize: true,
      priority: "low",
    });
    await client.releaseAgentConnection(ready.id);
    released = true;
    await expectRevoked(() => client.embed(renewedProvider, {
      texts: ["released credential check"],
      type: "query",
      normalize: true,
      priority: "low",
    }));
    const finalActivity = await client.getServiceActivity();
    return {
      ok: true,
      releaseCommit: health.releaseCommit,
      configRevision: health.configRevision,
      bootEpoch: health.bootEpoch,
      catalogRevision: profiles.catalogRevision,
      profile: profile.id,
      provider: renewedProvider.name,
      model: renewedProvider.model,
      modelId: space.model.id,
      modelRevision: space.model.revision,
      artifactDigest: space.model.artifactDigest,
      dimension: space.dimension,
      normalization: space.normalization,
      queryNorm: Number(norm(query.embeddings[0]!).toFixed(6)),
      passageNorm: Number(norm(passage.embeddings[0]!).toFixed(6)),
      capacity: renewedProvider.capacity,
      initialActivity: initialActivity.state,
      finalActivity: finalActivity.state,
      renewed: true,
      oldCredentialRevoked: true,
      released: true,
      releasedCredentialRevoked: true,
    };
  } finally {
    if (!released) await client.releaseAgentConnection(created.id).catch(() => undefined);
  }
}

if (import.meta.main) {
  const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
  try {
    const result = await runEmbeddingSmoke({
      baseUrl,
      ...(process.env.LARM_API_TOKEN ? { apiToken: process.env.LARM_API_TOKEN } : {}),
      ...(process.env.LARM_EXPECTED_RELEASE_COMMIT
        ? { expectedReleaseCommit: process.env.LARM_EXPECTED_RELEASE_COMMIT }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`embedding smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
