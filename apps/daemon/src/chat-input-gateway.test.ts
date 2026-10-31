import { expect, test } from "bun:test";
import { ChatInputError, chatInputPolicySchema } from "@larm/core";
import { prepareChatInput } from "./chat-input-gateway";
import { proxyGateway } from "./gateway";
import { ExecutionGate } from "./execution-gate";
import type { RuntimeDefinition } from "@larm/core";

const policy=chatInputPolicySchema.parse({});
const window={maxTokens:200,outputReserveTokens:32,safetyMarginTokens:8};
const plain={model:"fixture",messages:[{role:"user",content:"hi"}]};
const countResponse=(n=20)=>Response.json({contractVersion:"llama-chat-token-count.v1",promptTokens:n,textTokens:n,imageTokens:0,imageCount:0,engineBuild:"fixture"});
const options={endpoint:"http://provider",policy,window,runtime:"fixture-runtime",configRevision:"revision",bootEpoch:"epoch",requestId:"count",signal:new AbortController().signal};
test("preflight reports exact counts and fit independently of HTTP bytes",async()=>{
  const out=await prepareChatInput({...options,body:new TextEncoder().encode(JSON.stringify(plain)),fetchImpl:async()=>countResponse(161)});
  expect(out.count).toMatchObject({promptTokens:161,inputBudgetTokens:160,requestedOutputTokens:32,fits:false});
  expect(JSON.parse(new TextDecoder().decode(out.body)).max_tokens).toBe(32);
});
test("repeated chat preflight preserves the prompt and explicit cache/slot controls", async () => {
  const input = { ...plain, max_tokens: 16, cache_prompt: true, id_slot: 2 };
  const body = new TextEncoder().encode(JSON.stringify(input));
  const outputs: Uint8Array[] = [];
  for (const requestId of ["first", "second"]) {
    const checked = await prepareChatInput({ ...options, requestId, body, fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject(input);
      return countResponse();
    } });
    expect(JSON.parse(new TextDecoder().decode(checked.body))).toEqual(input);
    outputs.push(checked.body);
  }
  expect(outputs[0]).toEqual(outputs[1]);
});
test("legacy text tokenizer or wrong image totals fail closed",async()=>{
  await expect(prepareChatInput({...options,body:new TextEncoder().encode(JSON.stringify(plain)),fetchImpl:async()=>Response.json({tokens:[1,2]})})).rejects.toMatchObject({code:"chat_token_count_unavailable"});
});
test("output aliases and oversized reservation cannot bypass the budget",async()=>{
  for(const extra of [{max_tokens:33},{n_predict:-1}]) await expect(prepareChatInput({...options,body:new TextEncoder().encode(JSON.stringify({...plain,...extra})),fetchImpl:async()=>{throw new Error("must not fetch");}})).rejects.toBeInstanceOf(ChatInputError);
});
const runtime:RuntimeDefinition={id:"fixture-runtime",capability:["llm.general","llm.vision"],chatInput:policy,protocol:"openai.chat-completions.v1",backend:"llama-swap",node:"node",policy:{class:"preferred"},resources:{estimatedMemoryGB:1,maxConcurrentRequests:1,maxQueuedRequests:1,queueTimeoutMs:100},deployment:{modelId:"fixture",listen:"http://provider",endpoint:"http://provider"}};
const binding={runtime:runtime.id,endpoint:"http://provider"};
const base={allocationId:"alloc_fixture",protocol:"openai.chat-completions.v1" as const,upstreamPath:"/v1/chat/completions",runtime,chatInputWindow:window,bodyMode:"buffered" as const,maxBodyBytes:policy.maxRequestBytes,timeoutMs:100,bootEpoch:"epoch",revalidate:()=>({ok:true as const,binding})};
const request=()=>new Request("http://larm/v1/chat/completions",{method:"POST",body:JSON.stringify(plain)});
test("count-only neither forwards generation nor captures full-required audit payloads",async()=>{
  const calls:string[]=[];let finishes=0;
  const res=await proxyGateway({...base,request:request(),executionGate:new ExecutionGate(),countChatInputOnly:true,inferenceAuditMode:"full-required",inferenceAuditRecorder:{begin:async()=>{throw new Error("must not capture");}},fetchImpl:async(url)=>{calls.push(String(url));return countResponse();},onFinish:()=>{finishes++;}});
  expect(res.status).toBe(200);expect((await res.json() as { fits:boolean }).fits).toBe(true);expect(calls).toEqual(["http://provider/tokenize"]);expect(finishes).toBe(1);expect(res.headers.get("cache-control")).toBe("no-store");
});
test("generation is refused before forwarding when the measured context exceeds reservation",async()=>{
  const calls:string[]=[];const gate=new ExecutionGate();
  const res=await proxyGateway({...base,request:request(),executionGate:gate,fetchImpl:async(url)=>{calls.push(String(url));return countResponse(161);}});
  expect(res.status).toBe(400);expect((await res.json() as {error:{code:string}}).error.code).toBe("context_budget_exceeded");expect(calls).toEqual(["http://provider/tokenize"]);expect(gate.snapshot(runtime.id).active).toBe(0);
});
test("timeout frees execution while a broken preflight fetch ignores abort",async()=>{
  const gate=new ExecutionGate();const res=await proxyGateway({...base,request:request(),timeoutMs:10,executionGate:gate,fetchImpl:()=>new Promise(()=>{})});
  expect(res.status).toBe(504);expect(gate.snapshot(runtime.id).active).toBe(0);
});

test("lease invalidation during preprocessing cannot forward generation", async () => {
  let invalid=false;const calls:string[]=[];const gate=new ExecutionGate();
  const res=await proxyGateway({...base,request:request(),executionGate:gate,revalidate:()=>invalid?{ok:false as const,status:410,body:{error:{code:"connection_expired",message:"expired"}}}:{ok:true as const,binding},fetchImpl:async(url)=>{calls.push(String(url));invalid=true;return countResponse();}});
  expect(res.status).toBe(410);expect(calls).toEqual(["http://provider/tokenize"]);expect(gate.snapshot(runtime.id).active).toBe(0);
});

test("both formal counting and generation reject dropped instructions before tokenization or inference", async () => {
  const input = { model: "fixture", messages: [{ role: "system", content: "synthetic" }, { role: "user", content: "hi" }, { role: "system", content: "late synthetic" }] };
  for (const countChatInputOnly of [false, true]) {
    const calls: string[] = [];
    const gate = new ExecutionGate();
    const response = await proxyGateway({ ...base, request: new Request("http://larm/v1/chat/completions", { method: "POST", body: JSON.stringify(input) }),
      countChatInputOnly, executionGate: gate, fetchImpl: async (url, init) => {
        calls.push(String(url));
        const probe = JSON.parse(String(init?.body));
        return Response.json({ prompt: probe.messages[0].content + probe.messages[1].content });
      } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "chat_instruction_template_unsupported" } });
    expect(calls).toEqual(["http://provider/apply-template"]);
    expect(gate.snapshot(runtime.id).active).toBe(0);
  }
});

test("count and generation keep every byte of supported instruction arrays", async () => {
  const messages = [{ role: "system", content: "first" }, { role: "user", content: "history" },
    { role: "assistant", content: "ready" }, { role: "system", content: "late synthetic reference" }, { role: "user", content: "question" }];
  const original = { model: "fixture", messages, max_tokens: 16 };
  const checked = await prepareChatInput({ ...options, body: new TextEncoder().encode(JSON.stringify(original)), fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/apply-template")) return Response.json({ prompt: JSON.stringify(body.messages) });
    expect(body).toEqual(original); return countResponse();
  } });
  expect(JSON.parse(new TextDecoder().decode(checked.body))).toEqual(original);
});

const remainingContextOptions = {
  ...options,
  window: { maxTokens: 200000, outputReserveTokens: 4096, safetyMarginTokens: 1976, outputLimit: "remaining-context" as const },
};
test("remaining-context output uses the measured prompt instead of a fixed 4096 cap", async () => {
  const checked = await prepareChatInput({ ...remainingContextOptions,
    body: new TextEncoder().encode(JSON.stringify(plain)), fetchImpl: async () => countResponse(10000) });
  expect(checked.count).toMatchObject({ requestedOutputTokens: 188024, inputBudgetTokens: 10000, fits: true });
  expect(JSON.parse(new TextDecoder().decode(checked.body)).max_tokens).toBe(188024);
});
test("remaining-context output accepts explicit budgets above 4096 and still checks total context", async () => {
  for (const [promptTokens, fits] of [[10000, true], [190000, false]] as const) {
    const checked = await prepareChatInput({ ...remainingContextOptions,
      body: new TextEncoder().encode(JSON.stringify({ ...plain, max_tokens: 8192 })),
      fetchImpl: async () => countResponse(promptTokens) });
    expect(checked.count).toMatchObject({ requestedOutputTokens: 8192, fits });
    expect(JSON.parse(new TextDecoder().decode(checked.body)).max_tokens).toBe(8192);
  }
});
test("remaining-context output rejects a prompt with no generation room", async () => {
  const checked = await prepareChatInput({ ...remainingContextOptions,
    body: new TextEncoder().encode(JSON.stringify(plain)), fetchImpl: async () => countResponse(198024) });
  expect(checked.count).toMatchObject({ requestedOutputTokens: 1, fits: false });
});
test("count and generation apply the same remaining-context budget", async () => {
  for (const countChatInputOnly of [false, true]) {
    let generations = 0;
    const response = await proxyGateway({ ...base, executionGate: new ExecutionGate(), chatInputWindow: remainingContextOptions.window,
      request: request(), countChatInputOnly, fetchImpl: async (url, init) => {
        if (String(url).endsWith("/tokenize")) return countResponse(10000);
        generations++;
        expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)).max_tokens).toBe(188024);
        return Response.json({ id: "fixture", created: 0, object: "chat.completion", model: "fixture",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      } });
    const responseBody = await response.json();
    expect(responseBody).not.toHaveProperty("error");
    expect(response.status).toBe(200);
    expect(generations).toBe(countChatInputOnly ? 0 : 1);
  }
});

test("mixed context pools keep OpenAI bodies unchanged and use authenticated internal placement", async () => {
  const mixed = { ...runtime, resources: { ...runtime.resources, maxConcurrentRequests: 3 }, contextPools: {
    defaultTokens: 128, pools: [{ maxTokens: 200, slots: 1 }, { maxTokens: 128, slots: 2 }],
  } };
  for (const contextTokens of [undefined, 200, 199]) {
    const forwarded: { headers: Headers; body: Record<string, unknown> }[] = [];
    const req = new Request("http://larm/v1/chat/completions", { method: "POST", headers: { "x-larm-context-tokens": "200" }, body: JSON.stringify(plain) });
    const res = await proxyGateway({ ...base, request: req, runtime: mixed, contextTokens, executionGate: new ExecutionGate(), validateChatResponse: false,
      prepareUpstreamHeaders: async (_binding, _id, _signal, metadata) => {
        expect(metadata.contextTokens).toBe(contextTokens ?? 128);
        return new Headers({ "x-larm-cache-key": "private-fixture" });
      }, fetchImpl: async (url, init) => {
        if (String(url).endsWith("/tokenize")) return countResponse();
        forwarded.push({ headers: new Headers(init?.headers), body: JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) });
        return Response.json({ choices: [] });
      } });
    await res.text();
    if (contextTokens === 199) { expect(res.status).toBe(503); expect(forwarded).toHaveLength(0); continue; }
    expect(res.status).toBe(200); expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get("x-larm-context-tokens")).toBe(String(contextTokens ?? 128));
    expect(forwarded[0]!.body).toEqual({ ...plain, max_tokens: 32 });
  }
});

test("mixed context generation refuses missing private authentication and excessive completion count", async () => {
  const mixed = { ...runtime, contextPools: { defaultTokens: 200, pools: [{ maxTokens: 200, slots: 1 }] } };
  for (const n of [undefined, 2]) {
    let generated = false;
    const res = await proxyGateway({ ...base, request: new Request("http://larm/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...plain, ...(n ? { n } : {}) }) }),
      runtime: mixed, executionGate: new ExecutionGate(), fetchImpl: async (url) => {
        if (String(url).endsWith("/tokenize")) return countResponse();
        generated = true; return Response.json({});
      } });
    await res.text(); expect(res.status).toBe(n ? 400 : 503); expect(generated).toBe(false);
  }
});
