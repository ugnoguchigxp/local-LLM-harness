import { expect, test } from "bun:test";
import { promptRetentionPolicySchema } from "@larm/core";
import { LlamaPromptRetention } from "./prompt-retention";

const policy = promptRetentionPolicySchema.parse({});
const input = () => ({ principal: "synthetic-principal", connection: "synthetic-connection", epoch: "boot-a", instance: ["instance-a", 1],
  endpoint: "http://engine/v1/../upstream", expiresAt: Date.now() + 100_000, now: Date.now(), requestId: "synthetic-request",
  policy, signal: new AbortController().signal, runtimeId: "runtime" });
const props = () => Response.json({ larm_prompt_cache: { enabled: true, authenticated: true, policy } });

test("retention scopes are authenticated, opaque and separated by connection and generation", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const adapter = new LlamaPromptRetention("a".repeat(64), (async (url, init) => {
    calls.push({ url: String(url), init }); return String(url).endsWith("/props") ? props() : Response.json({});
  }), () => true);
  const original = input();
  const a = JSON.parse((await adapter.headers(original)).get("x-larm-cache-context")!);
  const b = JSON.parse((await adapter.headers({ ...original, connection: "other" })).get("x-larm-cache-context")!);
  const c = JSON.parse((await adapter.headers({ ...original, instance: ["instance-a", 2] })).get("x-larm-cache-context")!);
  expect(a.scope).not.toBe(b.scope); expect(a.instance).not.toBe(c.instance);
  expect(JSON.stringify(a)).not.toContain("synthetic");
  await adapter.invalidate(original.principal, original.connection, original.epoch);
  expect(calls.filter(c => c.url.endsWith("/invalidate"))).toHaveLength(2);
  await expect(adapter.headers(original)).rejects.toThrow("scope_revoked");
});

test("invalidation while capability discovery awaits cannot resurrect the scope", async () => {
  let finish!: (r: Response) => void;
  const adapter = new LlamaPromptRetention("a".repeat(64), (() => new Promise<Response>(resolve => { finish = resolve; })));
  const i = input(); const pending = adapter.headers(i);
  await adapter.invalidate(i.principal, i.connection, i.epoch); finish(props());
  await expect(pending).rejects.toThrow("scope_revoked");
});

test("policy mismatch cannot silently advertise supported retention", async () => {
  const adapter = new LlamaPromptRetention("a".repeat(64), (async () => Response.json({ larm_prompt_cache: { enabled: true, authenticated: true, policy: { ...policy, maxBytes: 16 * 1024 ** 3 } } })));
  await expect(adapter.headers(input())).rejects.toThrow("capability_mismatch");
});

test("matching policy with a mismatched engine key cannot silently fall back to cold requests", async () => {
  const suppliedKeys: (string | null)[] = [];
  const adapter = new LlamaPromptRetention("a".repeat(64), async (_url, init) => {
    suppliedKeys.push(new Headers(init?.headers).get("x-larm-cache-key"));
    return Response.json({ larm_prompt_cache: { enabled: true, authenticated: false, policy } });
  });
  await expect(adapter.headers(input())).rejects.toThrow("capability_mismatch");
  expect(suppliedKeys).toEqual(["a".repeat(64)]);
});

test("expired or stopped instances are never woken by cache invalidation", async () => {
  let posts = 0;
  const adapter = new LlamaPromptRetention("a".repeat(64), (async (_url, init) => { if (init?.method === "POST") posts++; return props(); }));
  const i = { ...input(), runtimeId: "runtime" };
  await adapter.headers(i); await adapter.invalidate(i.principal, i.connection, i.epoch);
  expect(posts).toBe(0);
});

test("OpenAI cache keys group one principal across Connections without changing authentication", async () => {
  const adapter = new LlamaPromptRetention("a".repeat(64), async () => props(), () => true);
  const i = input();
  const context = async (extra: Partial<typeof i> & { cacheKey?: string }) => JSON.parse((await adapter.headers({ ...i, ...extra })).get("x-larm-cache-context")!);
  const a = await context({ cacheKey: "synthetic-thread" });
  expect((await context({ connection: "other", cacheKey: "synthetic-thread" })).scope).toBe(a.scope);
  expect((await context({ cacheKey: "new-thread" })).scope).not.toBe(a.scope);
  expect((await context({ principal: "peer", cacheKey: "synthetic-thread" })).scope).not.toBe(a.scope);
  expect((await context({})).scope).not.toBe(a.scope);
  await adapter.invalidate(i.principal, i.connection, i.epoch);
  await expect(context({ cacheKey: "synthetic-thread" })).rejects.toThrow("scope_revoked");
  expect((await context({ connection: "other", cacheKey: "synthetic-thread" })).scope).toBe(a.scope);
});
