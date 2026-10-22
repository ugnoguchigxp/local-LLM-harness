import { expect, test } from "bun:test";
import { verifyPromptCache } from "./verify-prompt-cache";

function harness(options: { failClaim?: boolean; failPeer?: boolean; failRelease?: boolean; driftPeer?: boolean; cold?: boolean; ambiguousCreate?: boolean } = {}) {
  const released: string[] = [], emitted: Record<string, unknown>[] = [], completions: string[] = [];
  const creates = new Map<string, { id: string }>();
  let retried = false;
  const fakeClient = {
    listAgentProfilesV3: async () => ({ catalogRevision: "catalog" }),
    createAgentConnection: async (_request: unknown, requestOptions: { idempotencyKey: string }) => {
      const key = requestOptions.idempotencyKey;
      if (!creates.has(key)) creates.set(key, { id: `owned-${creates.size}` });
      if (options.ambiguousCreate && !retried) { retried = true; throw new Error("request timed out"); }
      return creates.get(key)!;
    },
    waitForAgentConnection: async () => undefined,
    claimAgentConnection: async (id: string) => {
      if (options.failClaim) throw new Error("claim failed");
      return { id, providers: [{ name: "llm", apiStyle: "openai", protocol: "openai.chat-completions.v1", model: "fixture", baseUrl: `http://fixture/${id}/v1`, credential: { token: "private-fixture-token" } }] };
    },
    releaseAgentConnection: async (id: string) => { released.push(id); if (options.failRelease) throw new Error("raw diagnostic must not escape"); },
  };
  const hits = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body));
    expect(init?.redirect).toBe("error");
    expect(body.cache_prompt).toBeUndefined();
    expect(body.id_slot).toBeUndefined();
    const system: string = body.messages[0].content, user: string = body.messages[1].content;
    const peer = url.includes("owned-1");
    const tokens = system === "" ? 24 : system.startsWith("Independent synthetic peer") ? 64
      : system.startsWith("Independent interleaving scenario") ? 3500 : user === "" ? 3410 : user.includes("beta") ? 3429 : 3424;
    if (url.endsWith("/input-tokens")) return Response.json({ contractVersion: "larm-chat-input-token-count.v1", model: "fixture", promptTokens: tokens, textTokens: tokens, imageTokens: 0, imageCount: 0,
      requestedOutputTokens: 16, safetyMarginTokens: 8, inputBudgetTokens: 7992, maxContextTokens: 8192, fits: true, requestDigest: "a".repeat(64), runtime: options.driftPeer && peer ? "different-runtime" : "shared-runtime", configRevision: "catalog", bootEpoch: "epoch", engineBuild: "build" });
    completions.push(url);
    if (options.failPeer && peer) return Response.json({ private: "must not escape" }, { status: 500 });
    const key = system + user, n = hits.get(key) ?? 0;
    hits.set(key, n + 1);
    const cache = options.cold ? 0 : n > 0 ? tokens - 4 : user.includes("beta") ? 2900 : 0;
    return Response.json({ timings: { prompt_n: tokens - cache, cache_n: cache, prompt_ms: 12 }, usage: { prompt_tokens: tokens, prompt_tokens_details: { cached_tokens: cache } }, choices: [{ finish_reason: "stop", message: { content: "private response must not escape" } }] });
  }) as typeof fetch;
  return {
    released, emitted, completions, creates,
    run: (baseline = false) => verifyPromptCache({ baseUrl: "http://fixture", apiToken: "private", profile: "ornith1.5Strix", baseline }, {
      client: fakeClient as unknown as NonNullable<Parameters<typeof verifyPromptCache>[1]>["client"],
      fetch: fetchImpl, emit: value => emitted.push(value), sleep: async () => {},
    }),
  };
}

test("acceptance verifies measured system prefix and an independently primed interleaving pair", async () => {
  const h = harness();
  const result = await h.run();
  expect(result.systemPrefixTokensEstimate).toBe(3386);
  expect(Object.keys(result.samples)).toEqual(["identical-first", "identical-second", "different-user", "before-other-connections", "other-connection-1", "after-other-connections"]);
  expect(h.released.sort()).toEqual(["owned-0", "owned-1"]);
  expect(JSON.stringify(h.emitted)).not.toContain("private");
});

test("partial setup and interleaved inference failures release only test-owned connections", async () => {
  const claim = harness({ failClaim: true });
  await expect(claim.run()).rejects.toThrow("claim failed");
  expect(claim.released).toEqual(["owned-0"]);
  const peer = harness({ failPeer: true });
  await expect(peer.run()).rejects.toThrow("inference HTTP 500");
  expect(peer.released.sort()).toEqual(["owned-0", "owned-1"]);
  expect(JSON.stringify(peer.emitted)).not.toContain("private");
});

test("same model alias cannot hide a different resolved runtime", async () => {
  const h = harness({ driftPeer: true });
  await expect(h.run()).rejects.toThrow("resolved runtime or generation changed");
  expect(h.released).toHaveLength(2);
});

test("cold cache fails acceptance while baseline remains explicitly observational", async () => {
  const rejected = harness({ cold: true });
  await expect(rejected.run()).rejects.toThrow("prefix reuse acceptance failed");
  expect(rejected.released).toHaveLength(2);
  expect((await harness({ cold: true }).run(true)).baseline).toBe(true);
});

test("cleanup failure is reported without replacing the primary error", async () => {
  const h = harness({ failClaim: true, failRelease: true });
  await expect(h.run()).rejects.toThrow("claim failed");
  expect(h.emitted).toEqual([{ cleanupIncomplete: true, remainingTestConnections: 1 }]);
});

test("ambiguous create retry recovers the same ID using the same idempotency key", async () => {
  const h = harness({ ambiguousCreate: true });
  await h.run();
  expect(h.creates.size).toBe(2);
  expect(h.released.sort()).toEqual(["owned-0", "owned-1"]);
});
