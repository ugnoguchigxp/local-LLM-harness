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
