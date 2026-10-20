import { DecisionError } from "./decision-errors";
export { DecisionError } from "./decision-errors";
import { fitDecisionHeadAsync } from "./decision-fit";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  DECISION_MODEL, DECISION_REVISION, decisionCanonical, decisionExampleSchema,
  decisionLabels, decisionMetrics, headProbabilities, validateDecisionQuestions,
  type DecisionExample, type DecisionTrainingRequest, type DecisionHead, type DecisionObservation,
  type SystemOneRequest, type SystemOneResponse,
} from "@larm/core";

export type DecisionSession = {
  predict: (body: SystemOneRequest) => Promise<SystemOneResponse>;
  close: () => Promise<void>;
};
type Dataset = { id: string; count: number; bytes: number; createdAt: string; splits: Record<string, number> };
type Adapter = {
  id: string; version: number; model: string; revision: string;
  questionSet: { id: string; version: number }; heads: Record<string, DecisionHead>;
  createdAt: string; method: "frozen-d1-log-probability-head";
};
type Job = {
  jobId: string; status: "queued" | "running" | "completed" | "failed";
  datasetId: string; createdAt: string; progress: { completed: number; total: number; phase: string };
  result?: { adapter: { id: string; version: number }; metrics: unknown; resources: { elapsedMs: number; featureMs: number; fitMs: number; headBytes: number } };
  error?: { code: string }; finishedAt?: string;
};
type Receipt = { hash: string; result: unknown };
type Index = { datasets: Dataset[]; jobs: Job[]; receipts: Record<string, Receipt> };
export const decisionHash = (value: unknown) => createHash("sha256").update(decisionCanonical(value)).digest("hex");
const adapterKey = (a: { id: string; version: number }) => `${a.id}.${a.version}`;
const active = (j: Job) => j.status === "running" || j.status === "queued";

/** One writer owns this directory. Only immutable heads are resident, never training states or labels. */
export class DecisionManager {
  private readonly adapters = new Map<string, Adapter>();
  private readonly index: Index;
  constructor(readonly root: string, private readonly openSession: (onPhase?: (phase: string) => void) => Promise<DecisionSession>) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    for (const directory of ["datasets", "adapters"]) mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    this.index = existsSync(join(root, "index.json")) ? JSON.parse(readFileSync(join(root, "index.json"), "utf8")) : { datasets: [], jobs: [], receipts: {} };
    // Reconcile upload/delete interruptions without retaining invisible raw training records.
    this.index.datasets = this.index.datasets.filter(d => existsSync(join(root, "datasets", `${d.id}.json`)));
    const retained = new Set(this.index.datasets.map(d => `${d.id}.json`));
    for (const file of readdirSync(join(root, "datasets"))) {
      if (!retained.has(file) && /^ds-[a-z0-9-]+\.json(?:\.tmp)?$/.test(file)) unlinkSync(join(root, "datasets", file));
    }
    for (const job of this.index.jobs) if (active(job)) {
      job.status = "failed"; job.error = { code: "decision_job_interrupted" }; job.finishedAt = new Date().toISOString();
    }
    for (const file of readdirSync(join(root, "adapters"))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[1-9][0-9]*\.json$/.test(file)) continue;
      const adapter: Adapter = JSON.parse(readFileSync(join(root, "adapters", file), "utf8"));
      if (adapter.revision !== DECISION_REVISION || adapter.model !== DECISION_MODEL) throw new Error("decision_adapter_revision_mismatch");
      this.adapters.set(adapterKey(adapter), adapter);
    }
    this.save();
  }
  private write(path: string, value: unknown) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }
  private save() { this.write(join(this.root, "index.json"), this.index); }
  private mutation<T>(scope: string, key: string, input: unknown, action: () => T): T {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new DecisionError("decision_idempotency_key_required");
    const receiptKey = decisionHash([scope, key]);
    const hash = decisionHash(input);
    const old = this.index.receipts[receiptKey];
    if (old) {
      if (old.hash !== hash) throw new DecisionError("decision_idempotency_conflict", 409);
      return structuredClone(old.result) as T;
    }
    if (Object.keys(this.index.receipts).length >= 10_000 && !scope.startsWith("delete-")) throw new DecisionError("decision_storage_limit", 429);
    const result = action();
    this.index.receipts[receiptKey] = { hash, result: structuredClone(result) };
    this.save();
    return result;
  }
  upload(text: string, key: string): Dataset {
    return this.mutation("upload", key, text, () => {
      const bytes = Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024 || this.index.datasets.reduce((s, d) => s + d.bytes, bytes) > 64 * 1024 * 1024 || this.index.datasets.length >= 100) throw new DecisionError("decision_storage_limit", 413);
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2 || lines.length > 2000) throw new DecisionError("decision_dataset_limit", 413);
      const ids = new Set<string>(), tasks = new Map<string, string>();
      const splits: Record<string, number> = { train: 0, calibration: 0, eval: 0 };
      const rows = lines.map(line => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new DecisionError("decision_invalid_dataset"); }
        const parsed = decisionExampleSchema.safeParse(value);
        if (!parsed.success) throw new DecisionError("decision_invalid_dataset");
        const row = parsed.data;
        if (Buffer.byteLength(decisionCanonical(row.state)) > 50_000) throw new DecisionError("decision_state_limit", 413);
        if (ids.has(row.id) || (tasks.has(row.task) && tasks.get(row.task) !== row.split)) throw new DecisionError("decision_split_leakage");
        ids.add(row.id); tasks.set(row.task, row.split); splits[row.split]!++;
        return row;
      });
      if (!splits.train || !splits.eval) throw new DecisionError("decision_split_required");
      const dataset: Dataset = { id: `ds-${randomUUID()}`, count: rows.length, bytes, splits, createdAt: new Date().toISOString() };
      this.write(join(this.root, "datasets", `${dataset.id}.json`), rows);
      this.index.datasets.push(dataset);
      return dataset;
    });
  }
  listDatasets() { return structuredClone(this.index.datasets); }
  getDataset(id: string) { return structuredClone(this.index.datasets.find(d => d.id === id)); }
  deleteDataset(id: string, key: string) {
    return this.mutation(`delete-dataset:${id}`, key, id, () => {
      if (this.index.jobs.some(j => j.datasetId === id && active(j))) throw new DecisionError("decision_dataset_in_use", 409);
      const d = this.index.datasets.find(d => d.id === id);
      if (!d) throw new DecisionError("decision_dataset_not_found", 404);
      unlinkSync(join(this.root, "datasets", `${d.id}.json`));
      this.index.datasets.splice(this.index.datasets.indexOf(d), 1);
      return { deleted: true };
    });
  }
  listAdapters() { return [...this.adapters.values()].map(a => this.publicAdapter(a)); }
  private publicAdapter(a: Adapter) { const { heads, ...metadata } = a; return { ...metadata, questionIds: Object.keys(heads), headBytes: Buffer.byteLength(JSON.stringify(heads)) }; }
  getAdapter(id: string, version: number) { const a = this.adapters.get(adapterKey({ id, version })); return a ? this.publicAdapter(a) : undefined; }
  deleteAdapter(id: string, version: number, key: string) {
    return this.mutation(`delete-adapter:${id}:${version}`, key, [id, version], () => {
      const k = adapterKey({ id, version });
      const a = this.adapters.get(k);
      if (!a) throw new DecisionError("decision_adapter_not_found", 404);
      unlinkSync(join(this.root, "adapters", `${k}.json`));
      this.adapters.delete(k);
      return { deleted: true };
    });
  }
  validateAdapter(request: SystemOneRequest): Adapter | undefined {
    if (!request.adapter) return undefined;
    const a = this.adapters.get(adapterKey(request.adapter));
    if (!a) throw new DecisionError("decision_adapter_not_found", 404);
    if (request.model !== a.model || decisionCanonical(request.questionSet) !== decisionCanonical(a.questionSet)
      || Object.entries(request.questions).some(([id, q]) => !a.heads[id] || a.heads[id]!.questionHash !== decisionHash(q))) {
      throw new DecisionError("decision_adapter_mismatch", 409);
    }
    return a;
  }
  apply(request: SystemOneRequest, response: SystemOneResponse): SystemOneResponse {
    const a = this.validateAdapter(request); // Revalidate after inference, so deletion revokes in-flight requests too.
    const result = structuredClone(response);
    result.adapter = request.adapter ?? null;
    if (!a) return result;
    for (const [id, question] of Object.entries(request.questions)) {
      const head = a.heads[id]!;
      const answer = result.answers[id]!;
      const probabilities = this.probabilities(answer, head.labels, question.type);
      const probs = headProbabilities(head, probabilities);
      const best = probs.indexOf(Math.max(...probs));
      answer.confidence = probs[best]!;
      if (question.type === "noul") answer.noul = probs[0]!;
      else {
        answer.probabilities = Object.fromEntries(head.labels.map((label, i) => [label, probs[i]!]));
        if (question.type === "choice") answer.choice = head.labels[best]!;
        else answer.score = probs.reduce((s, p, i) => s + Number(head.labels[i]) * p, 0);
      }
    }
    return result;
  }
  private probabilities(answer: SystemOneResponse["answers"][string], labels: string[], type: string) {
    const values = type === "noul" ? [answer.noul!, 1 - answer.noul!] : labels.map(label => answer.probabilities?.[label] ?? NaN);
    if (values.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(values.reduce((s, p) => s + p, 0) - 1) > 1e-4) throw new DecisionError("decision_invalid_model_response", 503);
    return values;
  }
  create(request: DecisionTrainingRequest, key: string): Job {
    let launch: { job: Job; rows: DecisionExample[] } | undefined;
    const result = this.mutation("train", key, request, () => {
      if (this.index.jobs.some(active)) throw new DecisionError("decision_training_busy", 429);
      if (this.index.jobs.length >= 1000 || this.adapters.size >= 1000) throw new DecisionError("decision_storage_limit", 429);
      if (!validateDecisionQuestions(request.questionSet.questions)) throw new DecisionError("decision_invalid_question_set");
      const dataset = this.index.datasets.find(d => d.id === request.datasetId);
      if (!dataset) throw new DecisionError("decision_dataset_not_found", 404);
      const rows: DecisionExample[] = JSON.parse(readFileSync(join(this.root, "datasets", `${dataset.id}.json`), "utf8"));
      const byQuestion = new Map<string, DecisionExample[]>();
      for (const row of rows) {
        const q = request.questionSet.questions[row.questionId];
        if (!q || row.questionSetId !== request.questionSet.id || row.questionSetVersion !== request.questionSet.version) throw new DecisionError("decision_question_set_mismatch", 409);
        const valid = q.type === "noul" ? typeof row.label === "boolean" : q.type === "score"
          ? typeof row.label === "number" && row.label < decisionLabels(q).length
          : typeof row.label === "string" && decisionLabels(q).includes(row.label);
        if (!valid) throw new DecisionError("decision_invalid_label");
        byQuestion.set(row.questionId, [...(byQuestion.get(row.questionId) ?? []), row]);
      }
      for (const id of Object.keys(request.questionSet.questions)) {
        const examples = byQuestion.get(id) ?? [];
        if (!examples.some(r => r.split === "train") || !examples.some(r => r.split === "eval")) throw new DecisionError("decision_split_required");
      }
      const job: Job = { jobId: `job-${randomUUID()}`, status: "queued", datasetId: dataset.id, createdAt: new Date().toISOString(), progress: { completed: 0, total: rows.length, phase: "queued" } };
      this.index.jobs.push(job); launch = { job, rows }; return job;
    });
    if (launch) {
      const { job, rows } = launch;
      queueMicrotask(() => { void this.run(job, request, rows); });
    }
    return structuredClone(result);
  }
  getJob(id: string) { return structuredClone(this.index.jobs.find(j => j.jobId === id)); }
  private async run(job: Job, request: DecisionTrainingRequest, rows: DecisionExample[]) {
    const started = performance.now(); let session: DecisionSession | undefined;
    try {
      job.status = "running"; job.progress.phase = "features"; this.save();
      session = await this.openSession(phase => {
        if (job.progress.phase !== phase) { job.progress.phase = phase; this.save(); }
      });
      const observations = new Map<string, { row: DecisionExample; observation: DecisionObservation }[]>();
      for (const row of rows) {
        if (performance.now() - started > 30 * 60 * 1000) throw new DecisionError("decision_job_timeout", 503);
        const q = request.questionSet.questions[row.questionId]!;
        const response = await session.predict({ model: DECISION_MODEL, state: row.state, questions: { [row.questionId]: q } });
        const labels = decisionLabels(q);
        const probabilities = this.probabilities(response.answers[row.questionId]!, labels, q.type);
        const observation = { probabilities, label: labels.indexOf(String(row.label)) };
        observations.set(row.questionId, [...(observations.get(row.questionId) ?? []), { row, observation }]);
        job.progress.completed++; if (job.progress.completed % 10 === 0) this.save();
      }
      await session.close(); session = undefined; // GPU demand ends before CPU head fitting.
      const featureMs = performance.now() - started;
      job.progress.phase = "fit"; this.save();
      const heads: Record<string, DecisionHead> = {}, metrics: Record<string, unknown> = {};
      for (const [id, values] of observations) {
        const q = request.questionSet.questions[id]!, labels = decisionLabels(q);
        const head = await fitDecisionHeadAsync(labels, decisionHash(q), values.filter(v => v.row.split === "train").map(v => v.observation));
        heads[id] = head;
        const splitMetrics = (split: string) => {
          const held = values.filter(v => v.row.split === split).map(v => v.observation);
          return { base: decisionMetrics(labels, held), adapted: decisionMetrics(labels, held.map(v => ({ ...v, probabilities: headProbabilities(head, v.probabilities) }))) };
        };
        metrics[id] = { type: q.type, eval: splitMetrics("eval"), calibration: splitMetrics("calibration") };
      }
      const adapter: Adapter = { id: `ad-${randomUUID()}`, version: 1, model: DECISION_MODEL, revision: DECISION_REVISION,
        questionSet: { id: request.questionSet.id, version: request.questionSet.version }, heads,
        createdAt: new Date().toISOString(), method: "frozen-d1-log-probability-head" };
      const k = adapterKey(adapter);
      const residentBytes = [...this.adapters.values(), adapter].reduce((sum, a) => sum + Buffer.byteLength(JSON.stringify(a)), 0);
      if (residentBytes > 16 * 1024 * 1024) throw new DecisionError("decision_adapter_memory_limit", 429);
      // New versions always receive a fresh immutable artifact. Never overwrite an existing head.
      const path = join(this.root, "adapters", `${k}.json`);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(adapter), { mode: 0o600, flag: "wx" });
      linkSync(temporary, path); // Atomic publication, with exclusive creation of the immutable name.
      unlinkSync(temporary);
      this.adapters.set(k, adapter);
      job.status = "completed"; job.progress.phase = "completed";
      job.result = { adapter: { id: adapter.id, version: adapter.version }, metrics,
        resources: { featureMs, fitMs: performance.now() - started - featureMs, elapsedMs: performance.now() - started, headBytes: Buffer.byteLength(JSON.stringify(heads)) } };
    } catch (error) {
      job.status = "failed"; job.error = { code: error instanceof DecisionError ? error.code : "decision_training_failed" };
      job.progress.phase = "failed";
    } finally {
      try { await session?.close(); } catch { /* Connection TTL is a bounded fallback. Never log source content. */ }
      job.finishedAt = new Date().toISOString(); this.save();
    }
  }
}
