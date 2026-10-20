import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const origin = process.env.LARM_IMPACT_ORIGIN ?? "http://127.0.0.1:9810";
const activity = await (await fetch(`${origin}/v1/activity`)).json() as any;
if (activity.state !== "idle") throw new Error("conversation measurement requires an idle control plane");
const created = await fetch(`${origin}/v1/agent-connections`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ profile: "ornith1.5Strix", audience: "same-host", providers: ["llm"], client: `d1-impact-${randomUUID()}`, ttlSeconds: 600 }) });
if (!created.ok) throw new Error(`conversation create rejected ${created.status}`);
let connection = await created.json() as any;
const id = connection.id;
const output: any = { profile: "ornith1.5Strix", providers: ["llm"], activityBefore: activity.state, claimModel: null };
let stop = false;
let load: Promise<void> | undefined;
try {
  while (connection.status !== "ready") {
    if (["failed", "released", "expired"].includes(connection.status)) throw new Error("conversation connection failed");
    await Bun.sleep(100); connection = await (await fetch(`${origin}/v1/agent-connections/${id}`)).json();
  }
  const claimed = await fetch(`${origin}/v1/agent-connections/${id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "openai-provider-v1" }) });
  if (!claimed.ok) throw new Error(`conversation claim rejected ${claimed.status}`);
  const claim = await claimed.json() as any;
  const provider = claim.providers.find((p: any) => p.name === "llm");
  output.claimModel = provider.model;
  const chat = async () => {
    const started = performance.now();
    const r = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: provider.model, messages: [{ role: "user", content: "Reply with just OK." }], max_tokens: 4, temperature: 0 }) });
    const body = await r.json() as any;
    if (!r.ok) throw new Error(`conversation inference rejected ${r.status}: ${body.error?.code}`);
    return performance.now() - started;
  };
  await chat();
  const stats = (values: number[]) => { values.sort((a, b) => a - b); return { count: values.length, p50Ms: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)] }; };
  const baseline: number[] = [];
  for (let i = 0; i < 20; i++) baseline.push(await chat());
  output.d1WarmIdle = stats(baseline);
  let loadCalls = 0;
  load = (async () => { while (!stop) {
    const r = await fetch("http://127.0.0.1:18093/v1/systemone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "d1-3b-general", state: "利用者は今回の行動を許可した。", questions: { approved: { type: "noul", instructions: "行動は許可済みですか？" } } }) });
    await r.arrayBuffer(); if (r.ok) loadCalls++; else throw new Error(`d1 load failed ${r.status}`);
  } })();
  const concurrent: number[] = [];
  for (let i = 0; i < 20; i++) concurrent.push(await chat());
  stop = true; await load;
  output.duringTrainingFeatureLoad = stats(concurrent);
  output.featureCalls = loadCalls;
  output.limitations = "Synthetic maximal feature-extraction load on the same GPU, not a production training job. Both paths use different runtimes; hardware is shared. D1 already warm in both conditions. No end-user conversation.";
  writeFileSync("/srv/ai/evidence/d1-general-20261020/conversation-impact.json", JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  stop = true;
  await load?.catch(() => undefined);
  await fetch(`${origin}/v1/agent-connections/${id}`, { method: "DELETE" });
}
