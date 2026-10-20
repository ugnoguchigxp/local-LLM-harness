import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const origin = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const expected = process.env.LARM_EXPECTED_RELEASE_COMMIT;
if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error("an explicit expected production commit is required");
const evidence = process.env.LARM_DECISION_PRODUCTION_EVIDENCE_ROOT ?? "/srv/ai/evidence/d1-general-production-20261020";
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const env = readFileSync("/etc/larm/larm.env", "utf8");
const token = process.env.LARM_API_TOKEN ?? /^LARM_API_TOKEN=(.*)$/m.exec(env)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!token) throw new Error("Control credential unavailable");
const controlHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const connections = new Set<string>(), datasets = new Set<string>();
const adapters = new Map<string, { id: string; version: number }>();
function require(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function call(path: string, options: { body?: unknown; raw?: string; key?: string; token?: string; method?: string; status?: number | number[] } = {}): Promise<any> {
  const headers: Record<string, string> = { ...controlHeaders };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers["idempotency-key"] = options.key;
  if (options.raw !== undefined) headers["content-type"] = "application/x-ndjson";
  const response = await fetch(new URL(path, origin), { method: options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET"), headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: AbortSignal.timeout(360_000),
  });
  const value: any = response.status === 204 ? null : await response.json();
  require((Array.isArray(options.status) ? options.status : [options.status ?? 200]).includes(response.status), `unexpected HTTP ${response.status} at ${path.split("?")[0]} (${value?.error?.code ?? "no code"})`);
  return value;
}
async function connect(profile: string, providers: string[]) {
  let connection = await call("/v1/agent-connections", { body: { profile, audience: "same-host", providers, client: `d1-production-${randomUUID()}`, ttlSeconds: 600 }, key: randomUUID(), status: [201, 202] });
  connections.add(connection.id);
  const deadline = Date.now() + 300_000;
  while (connection.status !== "ready") {
    require(!["failed", "released", "expired"].includes(connection.status) && Date.now() < deadline, `connection failed for ${profile}`);
    await Bun.sleep(200); connection = await call(`/v1/agent-connections/${connection.id}`);
  }
  const claim = await call(`/v1/agent-connections/${connection.id}/claim`, { body: { format: "openai-provider-v1" } });
  require(claim.providers.length === 1, "unexpected provider set");
  return { connection, provider: claim.providers[0] };
}
async function close(id: string) { await call(`/v1/agent-connections/${id}`, { method: "DELETE", status: 204 }); connections.delete(id); }
const q = { type: "noul", instructions: "記載された行動は許可されていますか？許可済みまたは承認済みならyes、未承認または禁止ならno。" };
const questions = { approved: q,
  category: { type: "choice", instructions: "行動の許可状態を分類してください。", criteria: { allowed: "許可済み", denied: "禁止されている" } },
  risk: { type: "score", instructions: "危険度を評価してください。", criteria: ["安全", "不明", "危険"] },
};
const state = "利用者は資料の読み取りを明示的に許可した。今回の行動は資料を読むことである。";
const result: any = { observedAt: new Date().toISOString(), expectedRelease: expected, kind: "d1-general-production-acceptance" };
let failure: unknown;
try {
  const health = await call("/health");
  require(health.releaseCommit === expected, "production release identity mismatch");
  result.identity = { releaseCommit: health.releaseCommit, configRevision: health.configRevision, bootEpoch: health.bootEpoch };
  const catalog = await call("/v3/agent-profiles");
  const before = JSON.parse(readFileSync(`${evidence}/catalog-before.json`, "utf8"));
  for (const profile of before.profiles) require(isDeepStrictEqual(catalog.profiles.find((p: any) => p.id === profile.id), profile), `existing profile changed: ${profile.id}`);
  require(isDeepStrictEqual(catalog.services, before.services), "existing Control service catalog changed");
  require(catalog.defaultAgentProfile === before.defaultAgentProfile, "default profile changed");
  const discovery = await call("/v3/agent-profiles?profile=decisionGeneral");
  require(discovery.profiles.length === 1 && discovery.profiles[0].selectionPolicy === "explicit-only", "general selector mismatch");
  require(discovery.profiles[0].providers[0].capability === "decision.general" && discovery.profiles[0].providers[0].description.includes("adapter"), "general description missing");
  result.catalog = { existingProfilesUnchanged: before.profiles.length, existingControlServicesUnchanged: before.services.length, capability: "decision.general", protocol: "larm.system-one.v1", endpoint: "/v1/systemone" };
  const session = await connect("decisionGeneral", ["decision"]);
  require(session.provider.capability === "decision.general" && session.provider.model === "d1-3b-general", "claim mismatch");
  const infer = (qs: any, extra: any = {}) => call(session.provider.endpoint, { token: session.provider.credential.token, body: { model: session.provider.model, state, questions: qs, ...extra } });
  const mixed = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, Object.values(questions)[i % 3]]));
  const start = performance.now(); const answer = await infer(mixed);
  require(answer.adapter === null && Object.keys(answer.answers).length === 12, "mixed answers or base adapter identity mismatch");
  Object.values(answer.answers).forEach((a: any, i) => require(a.type === ["noul", "choice", "score"][i % 3], "mixed answer type mismatch"));
  result.inference = { mixedQuestions: 12, types: ["noul", "choice", "score"], elapsedMs: performance.now() - start, usage: answer.usage, routing: answer.routing };
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `case-${i}`, task: `prod-check-task-${i}`, split: i < 180 ? "train" : i < 240 ? "calibration" : "eval", questionSetId: "production-inversion-demo", questionSetVersion: 1, questionId: "approved", state: `課題${i}。利用者は今回の行動を${i % 2 ? "明示的に禁止した" : "明示的に許可した"}。`, label: i % 2 !== 0 }));
  const jsonl = rows.map(r => JSON.stringify(r)).join("\n"); const uploadKey = randomUUID();
  const dataset = await call("/v1/decision/datasets", { raw: jsonl, key: uploadKey, status: 201 }); datasets.add(dataset.id);
  require((await call("/v1/decision/datasets", { raw: jsonl, key: uploadKey, status: 201 })).id === dataset.id, "dataset replay mismatch");
  const conflict = await call("/v1/decision/datasets", { raw: jsonl + "\n", key: uploadKey, status: 409 });
  require(conflict.error.code === "decision_idempotency_conflict", "idempotency conflict mismatch");
  const trainingBody = { model: session.provider.model, datasetId: dataset.id, questionSet: { id: "production-inversion-demo", version: 1, questions: { approved: q } } };
  const key = randomUUID(); const job = await call("/v1/decision/training-jobs", { body: trainingBody, key, status: 202 });
  require((await call("/v1/decision/training-jobs", { body: trainingBody, key, status: 202 })).jobId === job.jobId, "job replay mismatch");
  let done = job; const deadline = Date.now() + 600_000; let previousPhase = "";
  while (["queued", "running"].includes(done.status)) {
    require(Date.now() < deadline, "production job did not complete within verification window");
    if (done.progress.phase !== previousPhase) { console.log(JSON.stringify({ stage: "training", phase: done.progress.phase, completed: done.progress.completed, total: done.progress.total })); previousPhase = done.progress.phase; }
    await Bun.sleep(250); done = await call(`/v1/decision/training-jobs/${job.jobId}`);
  }
  require(done.status === "completed", `training failed (${done.error?.code ?? "unknown"})`);
  const adapter = done.result.adapter; adapters.set(adapter.id, adapter);
  const ref = { adapter, questionSet: { id: "production-inversion-demo", version: 1 } };
  const base = await infer({ approved: q }), adapted = await infer({ approved: q }, ref);
  require(isDeepStrictEqual(adapted.adapter, adapter) && base.adapter === null, "adapter response identity mismatch");
  require(Math.abs(adapted.answers.approved.noul - base.answers.approved.noul) > .05, "demonstration head had no measurable effect");
  const mismatch = await call(session.provider.endpoint, { token: session.provider.credential.token, body: { model: session.provider.model, state, questions: { approved: { ...q, instructions: "別の質問" } }, ...ref }, status: 409 });
  require(mismatch.error.code === "decision_adapter_mismatch", "question definition mismatch not rejected");
  require((await call("/v1/decision/adapters")).adapters.some((a: any) => a.id === adapter.id), "adapter missing from list");
  await call(`/v1/decision/datasets/${dataset.id}`, { method: "DELETE", key: randomUUID() }); datasets.delete(dataset.id);
  await call(`/v1/decision/datasets/${dataset.id}`, { status: 404 });
  await infer({ approved: q }, ref); // Proves inference does not need the training dataset.
  await call(`/v1/decision/adapters/${adapter.id}/versions/${adapter.version}`, { method: "DELETE", key: randomUUID() }); adapters.delete(adapter.id);
  const revoked = await call(session.provider.endpoint, { token: session.provider.credential.token, body: { model: session.provider.model, state, questions: { approved: q }, ...ref }, status: 404 });
  require(revoked.error.code === "decision_adapter_not_found", "deleted adapter not rejected");
  result.training = { jobId: job.jobId, status: done.status, examples: 300, metrics: done.result.metrics, resources: done.result.resources, labelConvention: "deliberately inverted synthetic labels; pipeline verification only", adapter, adapterDeleted: true, datasetDeleted: true, idempotencyVerified: true, mismatchRejected: true, deletedAdapterError: revoked.error.code };
  await close(session.connection.id);
  const game = await connect("ornith1.5Strix-game", ["game-decision"]);
  const gameAnswer = await call(game.provider.endpoint, { token: game.provider.credential.token, body: { model: game.provider.model, state: { player_x: 1, target_x: 3 }, questions: { action: { type: "choice", instructions: "Move toward target_x. Right increases x; left decreases x.", criteria: { left: "Move left", right: "Move right", wait: "Do not move" } } } } });
  require(gameAnswer.answers.action.choice === "right" && game.provider.capability === "decision.game", "legacy game regression");
  result.legacyGame = { model: game.provider.model, choice: gameAnswer.answers.action.choice }; await close(game.connection.id);
  const attitude = await connect("ornith1.5Strix", ["system-one"]);
  const attitudeAnswer = await call(attitude.provider.endpoint, { token: attitude.provider.credential.token, body: { model: attitude.provider.model, state: { response: "設定画面を開いてください。" }, questions: { emotion: { type: "choice", instructions: "現在の回答をアシスタント自身が話す表情と声色を選んでください", criteria: { none: "通常。事実・操作手順の説明", warmth: "親しみ。挨拶・感謝・温かい声かけ", joy: "喜び。達成や良い知らせを一緒に喜ぶ", empathy: "寄り添い。穏やかな気遣い・安心", curiosity: "興味。相手の話の続きを知りたい", surprise: "驚き。予想外の出来事への反応" } } } } });
  require(attitude.provider.capability === "decision.system-one" && attitudeAnswer.answers.emotion.choice === "none", "legacy attitude regression");
  result.legacyAttitude = { model: attitude.provider.model, choice: attitudeAnswer.answers.emotion.choice }; await close(attitude.connection.id);
  result.ok = true;
} catch (error) { failure = error; result.ok = false; result.error = error instanceof Error ? error.message : "verification_failed"; }
finally {
  for (const a of adapters.values()) await call(`/v1/decision/adapters/${a.id}/versions/${a.version}`, { method: "DELETE", key: randomUUID() }).catch(() => undefined);
  for (const id of datasets) await call(`/v1/decision/datasets/${id}`, { method: "DELETE", key: randomUUID() }).catch(() => undefined);
  for (const id of connections) await close(id).catch(() => undefined);
  result.finishedAt = new Date().toISOString();
  writeFileSync(`${evidence}/acceptance.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(result, null, 2));
if (failure) process.exitCode = 1;
