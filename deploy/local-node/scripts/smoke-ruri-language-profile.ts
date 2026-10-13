import { LarmClient, type SystemOneAgentProvider } from "../../../packages/client/src/index";

const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const client = new LarmClient({ baseUrl, apiToken: process.env.LARM_API_TOKEN, timeoutMs: 30_000 });
let id: string | undefined;
const languageRequest = (model: string, text: string) => ({ model, state: text,
  questions: { language: { type: "choice" as const, instructions: "文章全体が日本語か英語かを判定してください",
    criteria: { ja: "日本語文章", en: "英語文章" } } } });
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
try {
  const catalog = await client.listAgentProfilesV3("SAAA-gemma4-26b");
  const created = await client.createAgentConnection({ profile: "SAAA-gemma4-26b", audience: "same-host",
    client: "ruri-language-warm-canary", expectedCatalogRevision: catalog.catalogRevision,
    providers: ["system-one", "sentence-language"], ttlSeconds: 600,
    allowFallback: false, deploymentPolicy: "existing-only" }, { waitSeconds: 30 });
  id = created.id;
  const ready = await client.waitForAgentConnection(created, { timeoutMs: 60_000 });
  let claim = await client.claimAgentConnection(ready.id);
  const get = (name: string) => {
    const found = claim.providers.find((p): p is SystemOneAgentProvider => p.name === name && p.apiStyle === "larm-system-one");
    if (!found) throw new Error(`missing ${name} claim`);
    return found;
  };
  let language = get("sentence-language");
  const attitude = get("system-one");
  if (language.model !== "ruri-v3-30m-sentence-language") throw new Error("wrong sentence-language model");
  const raw = await Bun.file(new URL("../../../benchmarks/sentence-language/evaluation50.jsonl", import.meta.url)).text();
  const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as { text: string; language: string });
  let correct = 0;
  for (const row of rows) {
    const result = await client.systemOne(language, languageRequest(language.model, row.text));
    correct += Number(result.answers.language?.choice === row.language);
    if (result.routing?.encoder_session_count !== 1 || result.routing?.encoder_shared !== true) throw new Error("encoder not shared");
  }
  if (rows.length !== 50 || correct !== 50) throw new Error(`language accuracy ${correct}/${rows.length}`);
  const decision = await client.systemOne(attitude, { model: attitude.model, state: { response: "設定画面を開いてください。" },
    questions: { emotion: { type: "choice", instructions: "発話態度", criteria: {
      none: "通常", warmth: "親しみ", joy: "喜び", empathy: "寄り添い", curiosity: "興味", surprise: "驚き" } } } });
  if (decision.answers.emotion?.choice !== "none") throw new Error("attitude regression");
  // One credential cannot use the other model, even though they share a backend.
  const mismatch = await fetch(language.endpoint, { method: "POST", headers: {
    authorization: `Bearer ${language.credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: attitude.model, state: "x", questions: { q: { type: "choice", instructions: "x", criteria: { none: "通常" } } } }) });
  await mismatch.body?.cancel();
  if (mismatch.status !== 400) throw new Error(`cross-model request accepted: ${mismatch.status}`);
  const refreshed = await client.refreshAgentConnection(ready.id, { ttlSeconds: 600 });
  claim = refreshed.claim;
  language = get("sentence-language");
  const timings = [];
  for (const [expected, text] of [["ja", "これは日本語の文章です。"], ["en", "This sentence is written in English."]]) {
    const values: number[] = [];
    let failures = 0;
    let timeouts = 0;
    let wrong = 0;
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      try {
        const result = await client.systemOne(language, languageRequest(language.model, text!));
        wrong += Number(result.answers.language?.choice !== expected);
      } catch (error) {
        failures++;
        timeouts += Number(error instanceof Error && /timeout|abort/i.test(error.message));
      }
      values.push(performance.now() - started);
    }
    timings.push({ language: expected, trials: 200, failures, timeouts, wrong,
      p50_ms: percentile(values, .5), p95_ms: percentile(values, .95) });
  }
  const backend = await fetch("http://127.0.0.1:8087/health").then((r) => r.json()) as Record<string, unknown>;
  await client.releaseAgentConnection(ready.id); id = undefined;
  const revoked = await fetch(language.endpoint, { method: "POST", headers: {
    authorization: `Bearer ${language.credential.token}`, "content-type": "application/json" },
    body: JSON.stringify(languageRequest(language.model, "これは日本語の文章です。")) });
  await revoked.body?.cancel();
  if (revoked.status !== 401) throw new Error(`credential not revoked: ${revoked.status}`);
  console.log(JSON.stringify({ ok: true, correct, total: rows.length, attitude: decision.answers.emotion?.choice,
    renewed: true, model_binding_enforced: true, credential_revoked: true,
    health: await client.getHealth(), backend, timings }, null, 2));
  if (timings.some((t) => t.failures || t.wrong)) throw new Error("language timing trial failed");
} finally {
  if (id) await client.releaseAgentConnection(id).catch(() => undefined);
}
