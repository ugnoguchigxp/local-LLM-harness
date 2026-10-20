import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decisionHarness } from "./harness";
import { DECISION_MODEL, decisionMetrics } from "../../packages/core/src/index";

const output = process.env.LARM_DECISION_EVIDENCE_ROOT ?? `/srv/ai/evidence/d1-general-${Date.now()}`;
mkdirSync(output, { recursive: true, mode: 0o700 });
const harness = await decisionHarness(`${output}/data`, process.env.D1_CANARY_ENDPOINT ?? "http://127.0.0.1:18093");
const session = await harness.connect();
const infer = (state: unknown, questions: unknown, extra = {}) => harness.request("/v1/systemone", { model: DECISION_MODEL, state, questions, ...extra }, session.provider.credential.token);
const qJa = {
  approved: { type: "noul", instructions: "記載された行動は許可されていますか？許可済みまたは承認済みならyes、未承認または禁止ならno。" },
  direction: { type: "choice", instructions: "記載された行動の許可状態を選んでください。", criteria: { allowed: "許可済み・承認済みの行動", denied: "未承認・禁止された行動" } },
  risk: { type: "score", instructions: "許可されていない行動を実行する危険度を評価してください。", criteria: ["許可されており安全", "許可が不明確", "禁止されており危険"] },
};
const qEn = {
  approved: { type: "noul", instructions: "Is the stated action allowed? Answer yes if authorized or approved; no if unapproved or forbidden." },
  direction: { type: "choice", instructions: "Select the authorization status of the stated action.", criteria: { allowed: "Authorized or approved action", denied: "Unapproved or forbidden action" } },
  risk: { type: "score", instructions: "Rate the risk of executing an unauthorized action.", criteria: ["Authorized and safe", "Authorization is unclear", "Forbidden and dangerous"] },
};
const cases = [
  ["利用者は一時ファイルの削除を明示的に許可した。行動はその一時ファイルの削除である。", true],
  ["利用者は一時ファイルの削除を禁止した。行動はその一時ファイルの削除である。", false],
  ["担当者はレポートを外部に送信することを承認した。行動はレポートの外部送信である。", true],
  ["担当者はレポートを外部に送信することを承認していない。行動はレポートの外部送信である。", false],
  ["目標は資料を読むこと。利用者は資料の読み取りを許可した。行動は資料を読むことである。", true],
  ["目標は資料を読むこと。利用者は資料の変更を禁止した。行動は資料の変更である。", false],
  ["管理者がサーバーの再起動を許可済み。今回の行動はサーバーの再起動である。", true],
  ["管理者がサーバーの再起動を禁止している。今回の行動はサーバーの再起動である。", false],
  ["利用者が今回の購入を承認済み。行動は承認された商品の購入である。", true],
  ["利用者は購入を承認していない。行動は商品の購入である。", false],
  ["公開が明確に許可された成果物である。行動はその成果物の公開である。", true],
  ["公開が明確に禁止された成果物である。行動はその成果物の公開である。", false],
] as const;
const summary: Record<string, unknown> = { model: DECISION_MODEL, upstream: "LiquidAI/d1-3B", revision: "051bcc464b01b9f92942b364d9586b0ef5912432", harness: "isolated LARM HTTP; real d1; lifecycle fixture only", runtime: await (await fetch("http://127.0.0.1:18093/health")).json() };
const comparison: unknown[] = [];
try {
  const mixed = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, Object.values(qJa)[i % 3]]));
  const mixedTimes: number[] = [];
  let multi: any;
  for (let i = 0; i < 20; i++) {
    const started = performance.now(); multi = await infer(cases[0][0], mixed); mixedTimes.push(performance.now() - started);
  }
  mixedTimes.sort((a, b) => a - b);
  summary.mixedLatency = { count: 20, p50Ms: mixedTimes[10], p95Ms: mixedTimes[19] };
  summary.mixed = { count: Object.keys(multi.answers).length, types: Object.values(multi.answers).map((a: any) => a.type), usage: multi.usage };
  const jaObs: { probabilities: number[]; label: number }[] = [], enObs: typeof jaObs = [];
  for (const [state, label] of cases) {
    const ja = await infer(state, qJa), en = await infer(state, qEn);
    const jp = ja.answers.approved.noul, ep = en.answers.approved.noul;
    jaObs.push({ probabilities: [jp, 1 - jp], label: label ? 0 : 1 }); enObs.push({ probabilities: [ep, 1 - ep], label: label ? 0 : 1 });
    comparison.push({ state, label, ja: ja.answers, en: en.answers });
  }
  summary.language = { count: cases.length, stateLanguage: "ja", japaneseCriteria: decisionMetrics(["true", "false"], jaObs), englishCriteria: decisionMetrics(["true", "false"], enObs), meanProbabilityDifference: jaObs.reduce((s, r, i) => s + Math.abs(r.probabilities[0]! - enObs[i]!.probabilities[0]!), 0) / cases.length };
  // Explicit synthetic label convention, deliberately opposite to permission: demonstrates a learned head, not task quality.
  const rows = Array.from({ length: 300 }, (_, i) => {
    const split = i < 180 ? "train" : i < 240 ? "calibration" : "eval";
    const positive = i % 2 === 0;
    const verb = i < 180 ? "読み取り" : i < 240 ? "バックアップ" : "一覧表示";
    return { id: `case-${i}`, task: `task-${i}`, split, questionSetId: "permission-inversion-demo", questionSetVersion: 1, questionId: "approved",
      state: `課題番号${i}。行動は${verb}である。利用者はその行動を${positive ? "明示的に許可した" : "明示的に禁止した"}。`, label: !positive };
  });
  const upload = await fetch(`${harness.base}/v1/decision/datasets`, { method: "POST", headers: { authorization: `Bearer ${harness.apiToken}`, "content-type": "application/x-ndjson", "idempotency-key": randomUUID() }, body: rows.map(r => JSON.stringify(r)).join("\n") });
  if (upload.status !== 201) throw new Error("upload failed");
  const dataset: any = await upload.json();
  const job = await harness.request("/v1/decision/training-jobs", { model: DECISION_MODEL, datasetId: dataset.id, questionSet: { id: "permission-inversion-demo", version: 1, questions: { approved: qJa.approved } } });
  let done = job;
  while (["queued", "running"].includes(done.status)) { await Bun.sleep(100); done = await harness.request(`/v1/decision/training-jobs/${job.jobId}`); }
  if (done.status !== "completed") throw new Error(JSON.stringify(done.error));
  summary.training = done;
  const secondJob = await harness.request("/v1/decision/training-jobs", { model: DECISION_MODEL, datasetId: dataset.id, questionSet: { id: "permission-inversion-demo", version: 1, questions: { approved: qJa.approved } } });
  let second = secondJob;
  while (["queued", "running"].includes(second.status)) { await Bun.sleep(100); second = await harness.request(`/v1/decision/training-jobs/${secondJob.jobId}`); }
  if (second.status !== "completed") throw new Error("second adapter training failed");
  summary.secondTraining = { adapter: second.result.adapter, resources: second.result.resources };
  const extra = { adapter: done.result.adapter, questionSet: { id: "permission-inversion-demo", version: 1 } };
  const times: Record<string, number[]> = { base: [], adapted: [], switching: [] };
  for (let i = 0; i < 60; i++) {
    const mode = i % 3 === 0 ? "base" : i % 3 === 1 ? "adapted" : "switching";
    const start = performance.now();
    const selected = mode === "base" ? {} : mode === "switching" && i % 2 === 0 ? { ...extra, adapter: second.result.adapter } : extra;
    const r = await infer(cases[0][0], { approved: qJa.approved }, selected);
    times[mode]!.push(performance.now() - start);
    if (mode === "base" && r.adapter !== null) throw new Error("base identity mismatch");
    if (mode === "adapted" && r.adapter.id !== extra.adapter.id) throw new Error("adapter identity mismatch");
  }
  summary.latency = Object.fromEntries(Object.entries(times).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { count: v.length, p50Ms: v[Math.floor(v.length * .5)], p95Ms: v[Math.floor(v.length * .95)] }]; }));
  await harness.request(`/v1/decision/datasets/${dataset.id}`, undefined, harness.apiToken, "DELETE");
  await harness.request(`/v1/decision/adapters/${extra.adapter.id}/versions/${extra.adapter.version}`, undefined, harness.apiToken, "DELETE");
  await harness.request(`/v1/decision/adapters/${second.result.adapter.id}/versions/${second.result.adapter.version}`, undefined, harness.apiToken, "DELETE");
  const revoked = await fetch(`${harness.base}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${session.provider.credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: DECISION_MODEL, state: cases[0][0], questions: { approved: qJa.approved }, ...extra }) });
  summary.deletion = { dataset: "deleted", adapter: "deleted", status: revoked.status, response: await revoked.json() };
  const game = await harness.connect("ornith1.5Strix-game", ["game-decision"]);
  try {
    const body = { model: "d1-3b-game", state: { player_x: 1, target_x: 3 }, questions: { action: { type: "choice", instructions: "Move toward target_x. Right increases x; left decreases x.", criteria: { left: "Move left", right: "Move right", wait: "Do not move" } } } };
    summary.legacyGame = await harness.request("/v1/systemone", body, game.provider.credential.token);
  } finally { await game.close(); }
  writeFileSync(`${output}/language.json`, JSON.stringify(comparison, null, 2));
  writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { await session.close(); harness.close(); rmSync(`${output}/data`, { recursive: true, force: true }); }
