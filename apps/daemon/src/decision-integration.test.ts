import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionHarness } from "../../../benchmarks/decision-general/harness";
import { decisionTrainingJobSchema, publicAgentProfileListV3Schema } from "@larm/core";

test("one scoped endpoint handles mixed questions, asynchronous training, adapter selection and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-http-")); let calls = 0, forwardedAdapter = false;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async r => {
    const b = await r.json() as any; calls++;
    if (b.adapter !== undefined) forwardedAdapter = true;
    return Response.json({ model: b.model, adapter: null, answers: Object.fromEntries(Object.entries(b.questions).map(([id, q]: [string, any]) => {
      if (q.type === "noul") { const p = b.state.observed ? .9 : .1; return [id, { type: "noul", noul: p, confidence: Math.max(p, 1 - p) }]; }
      if (q.type === "choice") { const labels = Object.keys(q.criteria); return [id, { type: "choice", choice: labels[0], confidence: .8, probabilities: { [labels[0]!]: .8, [labels[1]!]: .2 } }]; }
      return [id, { type: "score", score: .2, confidence: .8, probabilities: { "0": .8, "1": .2 }, legend: { "0": q.criteria[0], "1": q.criteria[1] } }];
    })), usage: { input_tokens: 32, output_tokens: 0 } });
  } });
  const h = await decisionHarness(root, `http://127.0.0.1:${peer.port}`);
  const session = await h.connect();
  const question = { type: "noul", instructions: "承認済みですか？" };
  try {
    const discovery = publicAgentProfileListV3Schema.parse(await h.request("/v3/agent-profiles?profile=decisionGeneral"));
    expect(discovery.profiles[0]!.selectionPolicy).toBe("explicit-only");
    expect(discovery.profiles[0]!.providers[0]!).toMatchObject({ capability: "decision.general", endpoint: "/v1/systemone", description: expect.stringContaining("adapter") });
    const types = [question, { type: "choice", instructions: "分類", criteria: { good: "良い", bad: "悪い" } }, { type: "score", instructions: "度合い", criteria: ["低い", "高い"] }];
    const questions = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, types[i % 3]]));
    const mixed = await h.request("/v1/systemone", { model: session.provider.model, state: { observed: true }, questions }, session.provider.credential.token);
    expect(Object.keys(mixed.answers)).toHaveLength(12); expect(mixed.adapter).toBeNull();
    expect(mixed.answers.q0.noul).toBe(.9); expect(mixed.answers.q1.choice).toBe("good"); expect(mixed.answers.q2.score).toBe(.2);
    expect((await fetch(`${h.base}/v1/decision/adapters`, { headers: { authorization: `Bearer ${session.provider.credential.token}` } })).status).toBe(401);
    expect((await fetch(`${h.base}/v1/decision/adapters`)).status).toBe(401);
    for (const [changes, status, code] of [
      [{ state: "あ".repeat(17000) }, 413, "decision_state_limit"],
      [{ questions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, question])) }, 422, "decision_question_limit"],
      [{ images: ["data:image/png;base64,YQ==", "data:image/png;base64,YQ=="] }, 413, "decision_image_limit"],
    ] as const) {
      const count = calls;
      const invalid = await fetch(`${h.base}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${session.provider.credential.token}`, "content-type": "application/json" }, body: JSON.stringify(Object.assign({ model: session.provider.model, state: "state", questions }, changes)) });
      expect(invalid.status).toBe(status); expect(await invalid.json()).toMatchObject({ error: { code } }); expect(calls).toBe(count);
    }
    const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({ id: `case-${i}`, task: `task-${i}`, split: i < 40 ? "train" : "eval", questionSetId: "guard", questionSetVersion: 1, questionId: "approved", state: { observed: i % 2 === 0 }, label: i % 2 !== 0 })).join("\n");
    const upload = await fetch(`${h.base}/v1/decision/datasets`, { method: "POST", headers: { authorization: `Bearer ${h.apiToken}`, "idempotency-key": "upload-http" }, body: lines });
    expect(upload.status).toBe(201); const dataset = await upload.json() as any;
    const created = await h.request("/v1/decision/training-jobs", { model: session.provider.model, datasetId: dataset.id, questionSet: { id: "guard", version: 1, questions: { approved: question } } });
    let job = created;
    for (let i = 0; i < 200 && ["queued", "running"].includes(job.status); i++) { await Bun.sleep(10); job = await h.request(`/v1/decision/training-jobs/${created.jobId}`); }
    expect(decisionTrainingJobSchema.parse(job).status).toBe("completed");
    const input = { model: session.provider.model, state: { observed: true }, questions: { approved: question }, adapter: job.result.adapter, questionSet: { id: "guard", version: 1 } };
    const adapted = await h.request("/v1/systemone", input, session.provider.credential.token);
    expect(adapted.adapter).toEqual(job.result.adapter); expect(adapted.answers.approved.noul).toBeLessThan(.5);
    expect(forwardedAdapter).toBe(false);
    await h.request(`/v1/decision/datasets/${dataset.id}`, undefined, h.apiToken, "DELETE");
    expect((await h.request("/v1/systemone", input, session.provider.credential.token)).answers.approved.noul).toBeLessThan(.5);
    await h.request(`/v1/decision/adapters/${input.adapter.id}/versions/1`, undefined, h.apiToken, "DELETE");
    const before = calls;
    const revoked = await fetch(`${h.base}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${session.provider.credential.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(revoked.status).toBe(404); expect(await revoked.json()).toMatchObject({ error: { code: "decision_adapter_not_found" } }); expect(calls).toBe(before);
  } finally { await session.close(); h.close(); peer.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
