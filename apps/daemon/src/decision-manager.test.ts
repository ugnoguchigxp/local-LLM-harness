import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_MODEL, type DecisionTrainingRequest, type SystemOneResponse } from "@larm/core";
import { DecisionManager, type DecisionSession } from "./decision-manager";

const question = { type: "noul" as const, instructions: "承認済みですか？" };
const makeRows = () => Array.from({ length: 240 }, (_, i) => ({ id: `case-${i}`, task: `task-${i}`,
  split: i < 160 ? "train" : i < 200 ? "calibration" : "eval", questionSetId: "guards", questionSetVersion: 1,
  questionId: "guard", state: { observed: i % 2 === 0, privateText: "sensitive-state" }, label: i % 2 !== 0 }));
const upload = (manager: DecisionManager, rows = makeRows(), key = "upload") => manager.upload(rows.map(r => JSON.stringify(r)).join("\n"), key);
const request = (datasetId: string): DecisionTrainingRequest => ({ model: DECISION_MODEL, datasetId, questionSet: { id: "guards", version: 1, questions: { guard: question } } });
const wait = async (manager: DecisionManager, id: string) => {
  for (let i = 0; i < 200; i++) { const job = manager.getJob(id)!; if (["completed", "failed"].includes(job.status)) return job; await Bun.sleep(5); }
  throw new Error("job did not finish");
};
const baseResponse = (yes: boolean): SystemOneResponse => ({ model: DECISION_MODEL, adapter: null,
  answers: { guard: { type: "noul", noul: yes ? .9 : .1, confidence: .9 } }, usage: { input_tokens: 10, output_tokens: 0 } });

test("async training, held-out metrics, immutable resident adapters, restart, and erasure", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-")); let calls = 0, closed = 0;
  const session: DecisionSession = { predict: async body => { calls++; return baseResponse((body.state as { observed: boolean }).observed); }, close: async () => { closed++; } };
  try {
    const manager = new DecisionManager(root, async () => session);
    const dataset = upload(manager);
    expect(upload(manager)).toEqual(dataset);
    expect(() => upload(manager, makeRows().slice(0, 100))).toThrow("decision_idempotency_conflict");
    const job = manager.create(request(dataset.id), "train");
    expect(job.status).toBe("queued");
    expect(manager.create(request(dataset.id), "train")).toEqual(job);
    expect(() => manager.deleteDataset(dataset.id, "delete-early")).toThrow("decision_dataset_in_use");
    const done = await wait(manager, job.jobId);
    expect(done.status).toBe("completed"); expect(calls).toBe(240); expect(closed).toBe(1);
    expect(done.result?.metrics).toMatchObject({ guard: { type: "noul", eval: { base: { count: 40, accuracy: 0 }, adapted: { count: 40, accuracy: 1 } }, calibration: { base: { count: 40 } } } });
    const adapter = done.result!.adapter;
    const inference = { model: DECISION_MODEL, state: { observed: true }, questions: { guard: question }, questionSet: { id: "guards", version: 1 }, adapter };
    expect(manager.apply(inference, baseResponse(true)).answers.guard!.noul!).toBeLessThan(.5);
    expect(manager.apply({ ...inference, adapter: undefined }, baseResponse(true)).answers.guard!.noul).toBe(.9);
    expect(() => manager.validateAdapter({ ...inference, questionSet: { id: "other", version: 1 } })).toThrow("decision_adapter_mismatch");
    expect(() => manager.validateAdapter({ ...inference, questions: { guard: { ...question, instructions: "異なる基準" } } })).toThrow("decision_adapter_mismatch");
    const restored = new DecisionManager(root, async () => session);
    expect(restored.getAdapter(adapter.id, adapter.version)).toBeDefined();
    expect(restored.apply(inference, baseResponse(true))).toEqual(manager.apply(inference, baseResponse(true)));
    restored.deleteDataset(dataset.id, "delete-dataset");
    expect(readdirSync(join(root, "datasets"))).toEqual([]);
    expect(readFileSync(join(root, "index.json"), "utf8")).not.toContain("sensitive-state");
    restored.deleteAdapter(adapter.id, adapter.version, "delete-adapter");
    expect(restored.deleteAdapter(adapter.id, adapter.version, "delete-adapter")).toEqual({ deleted: true });
    expect(() => restored.apply(inference, baseResponse(true))).toThrow("decision_adapter_not_found");
    expect(new DecisionManager(root, async () => session).listAdapters()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("splits never cross tasks, labels match the question, and failures release sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-")); let closed = false;
  try {
    const manager = new DecisionManager(root, async () => ({ predict: async () => { throw new Error("sensitive-state"); }, close: async () => { closed = true; } }));
    const rows = makeRows(); rows[200]!.task = rows[0]!.task;
    expect(() => upload(manager, rows)).toThrow("decision_split_leakage");
    const dataset = upload(manager);
    expect(() => manager.create({ ...request(dataset.id), questionSet: { id: "bad", version: 1, questions: { guard: question } } }, "bad-train")).toThrow("decision_question_set_mismatch");
    const job = manager.create(request(dataset.id), "train");
    const done = await wait(manager, job.jobId);
    expect(done.error).toEqual({ code: "decision_training_failed" }); expect(closed).toBe(true);
    expect(readFileSync(join(root, "index.json"), "utf8")).not.toContain("sensitive-state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("choice and score heads preserve named distributions and expected score with per-type metrics", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-types-"));
  const questions = {
    category: { type: "choice" as const, instructions: "分類", criteria: { alpha: "A", beta: "B" } },
    rating: { type: "score" as const, instructions: "評価", criteria: ["低い", "中間", "高い"] },
  };
  const response: SystemOneResponse = { model: DECISION_MODEL, adapter: null, usage: { input_tokens: 10, output_tokens: 0 }, answers: {
    category: { type: "choice", choice: "alpha", confidence: .9, probabilities: { alpha: .9, beta: .1 } },
    rating: { type: "score", score: .3, confidence: .8, probabilities: { "0": .8, "1": .1, "2": .1 }, legend: { "0": "低い", "1": "中間", "2": "高い" } },
  } };
  try {
    const manager = new DecisionManager(root, async () => ({ predict: async body => ({ ...response, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, response.answers[id]!])) }), close: async () => {} }));
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `case-${i}`, task: `task-${i}`, split: i < 40 ? "train" : "eval", questionSetId: "typed", questionSetVersion: 1, questionId: i % 2 ? "rating" : "category", state: "例", label: i % 2 ? 2 : "beta" }));
    const dataset = manager.upload(rows.map(r => JSON.stringify(r)).join("\n"), "upload");
    const job = manager.create({ model: DECISION_MODEL, datasetId: dataset.id, questionSet: { id: "typed", version: 1, questions } }, "train");
    const done = await wait(manager, job.jobId);
    expect(done.status).toBe("completed");
    expect(done.result?.metrics).toMatchObject({ category: { type: "choice", eval: { adapted: { count: 10, accuracy: 1 } } }, rating: { type: "score", eval: { adapted: { count: 10, accuracy: 1 } } } });
    const adapted = manager.apply({ model: DECISION_MODEL, state: "例", questions, adapter: done.result!.adapter, questionSet: { id: "typed", version: 1 } }, response);
    expect(adapted.answers.category!.choice).toBe("beta");
    expect(adapted.answers.rating!.score!).toBeGreaterThan(1.5);
    expect(adapted.answers.rating!.legend).toEqual(response.answers.rating!.legend);
    expect(Object.keys(adapted.answers.rating!.probabilities!)).toEqual(["0", "1", "2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("receipt capacity rejects new work while retaining the ability to erase uploaded labels", () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-full-"));
  const open = async (): Promise<DecisionSession> => { throw new Error("not used"); };
  try {
    const first = new DecisionManager(root, open);
    const dataset = upload(first);
    const path = join(root, "index.json");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.receipts = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), { hash: "receipt", result: {} }]));
    writeFileSync(path, JSON.stringify(persisted));
    const manager = new DecisionManager(root, open);
    expect(() => upload(manager, makeRows(), "new-upload")).toThrow("decision_storage_limit");
    expect(manager.deleteDataset(dataset.id, "erase-labels")).toEqual({ deleted: true });
    expect(readdirSync(join(root, "datasets"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
