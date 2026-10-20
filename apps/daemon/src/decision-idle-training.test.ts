import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionHarness } from "../../../benchmarks/decision-general/harness";

test("training yields to a foreground request and resumes the same job after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-decision-idle-"));
  let hold!: () => void;
  const held = new Promise<void>(resolve => { hold = resolve; });
  let holding = false;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async r => {
    const b = await r.json() as any;
    if (b.questions.hold) { holding = true; await held; }
    else await Bun.sleep(10);
    return Response.json({ model: b.model, adapter: null, answers: Object.fromEntries(Object.keys(b.questions).map(id => [id, { type: "noul", noul: .8, confidence: .8 }])), usage: { input_tokens: 10, output_tokens: 0 } });
  } });
  const h = await decisionHarness(root, `http://127.0.0.1:${peer.port}`);
  let foreground: Awaited<ReturnType<typeof h.connect>> | undefined;
  try {
    // Exercise the real foreground scheduling path with a tiny d1 peer instead of loading a conversation LLM.
    const fg = h.catalog.profiles.find(p => p.id === "saaa-conversation-gemma4-26b-voice")!;
    fg.providers = structuredClone(h.catalog.profiles.find(p => p.id === "decision-general-background")!.providers);
    fg.requestScheduling = "foreground-exclusive"; delete fg.idleRelease; delete fg.usageProtection;
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `case-${i}`, task: `task-${i}`, split: i < 70 ? "train" : "eval", questionSetId: "guard", questionSetVersion: 1, questionId: "approved", state: "状態", label: true }));
    const uploaded = await fetch(`${h.base}/v1/decision/datasets`, { method: "POST", headers: { authorization: `Bearer ${h.apiToken}`, "idempotency-key": "idle-test" }, body: rows.map(r => JSON.stringify(r)).join("\n") });
    const dataset = await uploaded.json() as any;
    const job = await h.request("/v1/decision/training-jobs", { model: "d1-3b-general", datasetId: dataset.id, questionSet: { id: "guard", version: 1, questions: { approved: { type: "noul", instructions: "許可済みか" } } } });
    let status: any;
    for (let i = 0; i < 100; i++) { status = await h.request(`/v1/decision/training-jobs/${job.jobId}`); if (status.progress.completed >= 3) break; await Bun.sleep(10); }
    expect(status.progress.completed).toBeGreaterThanOrEqual(3);
    foreground = await h.connect("SAAA-gemma4-26b", ["decision"]);
    const pending = h.request("/v1/systemone", { model: "d1-3b-general", state: "foreground", questions: { hold: { type: "noul", instructions: "wait" } } }, foreground.provider.credential.token);
    for (let i = 0; i < 100 && !holding; i++) await Bun.sleep(10);
    expect(holding).toBe(true);
    for (let i = 0; i < 200; i++) { status = await h.request(`/v1/decision/training-jobs/${job.jobId}`); if (status.progress.phase === "waiting_for_idle") break; await Bun.sleep(10); }
    expect(status.status).toBe("running"); expect(status.progress.phase).toBe("waiting_for_idle");
    const before = status.progress.completed;
    await Bun.sleep(1100);
    status = await h.request(`/v1/decision/training-jobs/${job.jobId}`);
    expect(status.progress.completed).toBe(before);
    hold(); await pending; await foreground.close(); foreground = undefined;
    for (let i = 0; i < 500; i++) { status = await h.request(`/v1/decision/training-jobs/${job.jobId}`); if (["completed", "failed"].includes(status.status)) break; await Bun.sleep(10); }
    expect(status.status).toBe("completed"); expect(status.progress.completed).toBe(100);
  } finally { hold(); await foreground?.close(); h.close(); peer.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
