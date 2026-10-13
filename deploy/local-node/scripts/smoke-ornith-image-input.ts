import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
// PNG uses the standard reflected CRC-32 polynomial.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";

const apiToken = process.env.LARM_API_TOKEN;
if (!apiToken) throw new Error("LARM_API_TOKEN is required; never print it");
const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const client = new LarmClient({ baseUrl, apiToken, timeoutMs: 180_000 });
const results: Array<Record<string, unknown>> = [];
const owned = new Set<string>();
function chunk(type: string, data: Buffer) {
  const tag = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])) >>> 0);
  return Buffer.concat([size, tag, data, crc]);
}
function png(color: number[], size = 384) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.alloc(1), Buffer.from(Array.from({ length: size }, () => color).flat())]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({length:size},()=>row)))), chunk("IEND", Buffer.alloc(0))]);
}
const red = png([255,0,0]); const blue = png([0,0,255]);
const jpeg = spawnSync("ffmpeg", ["-v","error","-i","pipe:0","-frames:v","1","-q:v","2","-f","image2pipe","-vcodec","mjpeg","pipe:1"], { input: red, maxBuffer: 4 * 1024 * 1024 });
if (jpeg.status !== 0) throw new Error("synthetic JPEG conversion failed");
const bitmapPixels=Buffer.from(Array.from({length:384*384},()=>[0,0,255]).flat());
const bmpHeader=Buffer.alloc(54);bmpHeader.write("BM");bmpHeader.writeUInt32LE(54+bitmapPixels.length,2);bmpHeader.writeUInt32LE(54,10);bmpHeader.writeUInt32LE(40,14);bmpHeader.writeInt32LE(384,18);bmpHeader.writeInt32LE(384,22);bmpHeader.writeUInt16LE(1,26);bmpHeader.writeUInt16LE(24,28);bmpHeader.writeUInt32LE(bitmapPixels.length,34);
const bmp=Buffer.concat([bmpHeader,bitmapPixels]);
const image=(data:Buffer,mime="image/png")=>({type:"image_url",image_url:{url:`data:${mime};base64,${data.toString("base64")}`}});
const text=(value:string)=>({type:"text",text:value});
async function connect(profile: "ornith1.5Strix" | "contextStill") {
  const catalog=await client.listAgentProfilesV3(profile);
  const created=await client.createAgentConnection({profile,expectedCatalogRevision:catalog.catalogRevision,audience:"same-host",providers:["llm"],client:`image-contract-smoke-${crypto.randomUUID()}`,ttlSeconds:600,allowFallback:false,deploymentPolicy:"existing-only"});
  owned.add(created.id);
  const connection=await client.waitForAgentConnection(created,{timeoutMs:180_000});
  const claim=await client.claimAgentConnection(connection.id);const provider=claim.providers.find(p=>p.name==="llm");
  if(!provider || provider.protocol!=="openai.chat-completions.v1" || !provider.chatInput)throw new Error("image contract absent from LLM claim");
  if(JSON.stringify(provider.chatInput)!==JSON.stringify(catalog.profiles[0]!.providers.find(p=>p.name==="llm")!.chatInput))throw new Error("discovery and claim contract differ");
  return {connection,provider};
}
async function infer(provider: Awaited<ReturnType<typeof connect>>["provider"], body: Record<string,unknown>) {
  const response=await fetch(provider.baseUrl+"/chat/completions",{method:"POST",headers:{authorization:`Bearer ${provider.credential.token}`,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(180_000)});
  if(!response.ok) {await response.body?.cancel();throw new Error(`inference HTTP ${response.status}`);}
  return response;
}
const bodyFor=(model:string,parts:unknown[])=>({model,max_tokens:128,temperature:0,chat_template_kwargs:{enable_thinking:false},response_format:{type:"json_object"},messages:[{role:"user",content:parts}]});
const required=(value:boolean, message:string)=>{if(!value)throw new Error(message);};
try {
  const health=await client.getHealth();
  const main=await connect("ornith1.5Strix");let provider=main.provider;
  for(const [name,bytes,mime] of [["png",red,"image/png"],["jpeg",jpeg.stdout,"image/jpeg"],["bmp",bmp,"image/bmp"]] as const) {
    const body=bodyFor(provider.model,[text("Identify the dominant color. Return JSON with color."),image(bytes,mime)]);
    const count=await client.countChatInputTokens(body,provider.credential.token);
    const response=await (await infer(provider,body)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{content:string}}>};
    required(count.promptTokens===response.usage.prompt_tokens,`usage mismatch ${name}`);
    required(JSON.parse(response.choices[0]!.message.content).color==="red",`image semantics ${name}`);
    results.push({case:name,promptTokens:count.promptTokens,imageTokens:count.imageTokens,ok:true});
  }
  const only=bodyFor(provider.model,[image(red)]);delete (only as Record<string,unknown>).response_format;
  const onlyCount=await client.countChatInputTokens(only,provider.credential.token);
  const onlyReply=await (await infer(provider,only)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{content:string}}>};
  required(onlyCount.promptTokens===onlyReply.usage.prompt_tokens && onlyReply.choices[0]!.message.content.length>0,"image-only failed");
  results.push({case:"image-only",promptTokens:onlyCount.promptTokens,ok:true});
  const two=bodyFor(provider.model,[text("Identify each image separately. Return JSON with first_color and second_color."),image(red),image(blue)]);
  const twoCount=await client.countChatInputTokens(two,provider.credential.token);
  const twoReply=await (await infer(provider,two)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{content:string}}>};
  const colors=JSON.parse(twoReply.choices[0]!.message.content);
  required(colors.first_color==="red" && colors.second_color==="blue" && twoCount.imageCount===2 && twoCount.imageTokens===288 && twoCount.promptTokens===twoReply.usage.prompt_tokens,"two independent images failed");
  results.push({case:"two-images",promptTokens:twoCount.promptTokens,imageTokens:twoCount.imageTokens,ok:true});
  const history={...bodyFor(provider.model,[]),messages:[{role:"user",content:[text("What color?"),image(red)]},{role:"assistant",content:'{"color":"red"}'},{role:"user",content:"What is the color of the previous image? Return JSON with color."}]};
  const historyCount=await client.countChatInputTokens(history,provider.credential.token);
  const historyReply=await (await infer(provider,history)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{content:string}}>};
  required(JSON.parse(historyReply.choices[0]!.message.content).color==="red" && historyCount.promptTokens===historyReply.usage.prompt_tokens,"image history resend failed");
  results.push({case:"history-resend",promptTokens:historyCount.promptTokens,ok:true});
  const stream={...bodyFor(provider.model,[text("Identify the dominant color. Return JSON with color."),image(red)]),stream:true,stream_options:{include_usage:true}};
  const streamCount=await client.countChatInputTokens(stream,provider.credential.token);const streamStart=performance.now();
  const streamResponse=await infer(provider,stream);const reader=streamResponse.body!.getReader();const decoder=new TextDecoder();let pending="",content="",usage:number|undefined,firstContentMs:number|undefined;
  try {while(true){const item=await reader.read();if(item.done)break;pending+=decoder.decode(item.value,{stream:true});let stop;while((stop=pending.indexOf("\n\n"))>=0){const event=pending.slice(0,stop);pending=pending.slice(stop+2);for(const line of event.split("\n")){if(!line.startsWith("data:") || line.slice(5).trim()==="[DONE]")continue;const value=JSON.parse(line.slice(5));for(const choice of value.choices??[]){if(choice.delta?.content){firstContentMs??=performance.now()-streamStart;content+=choice.delta.content;}}if(value.usage)usage=value.usage.prompt_tokens;}}}}
  finally {reader.releaseLock();}
  required(JSON.parse(content).color==="red" && usage===streamCount.promptTokens,"image stream failed");
  results.push({case:"image-stream",promptTokens:usage,firstContentMs,ok:true});
  const tool:Record<string,unknown>={...bodyFor(provider.model,[text("Call report_color with the dominant color of this image."),image(red)]),tools:[{type:"function",function:{name:"report_color",description:"Report the image's dominant color.",parameters:{type:"object",properties:{color:{type:"string",enum:["red","blue","green","yellow"]}},required:["color"],additionalProperties:false}}}],tool_choice:"required"};delete tool.response_format;
  const toolCount=await client.countChatInputTokens(tool,provider.credential.token);const toolReply=await (await infer(provider,tool)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{tool_calls?:Array<{function:{name:string;arguments:string}}>}}>};
  const call=toolReply.choices[0]!.message.tool_calls?.[0];required(call?.function.name==="report_color" && JSON.parse(call.function.arguments).color==="red" && toolReply.usage.prompt_tokens===toolCount.promptTokens,"native image tool call failed");
  results.push({case:"image-native-tools",promptTokens:toolCount.promptTokens,ok:true});
  for(const size of [1024,2048]) {
    const body=bodyFor(provider.model,[text("Identify the dominant color. Return JSON with color."),image(png([255,0,0],size))]);const started=performance.now();const count=await client.countChatInputTokens(body,provider.credential.token);const preflightMs=performance.now()-started;
    required(count.imageTokens===(size/32)**2,"large-image count mismatch");results.push({case:"large-image-count",width:size,height:size,imageTokens:count.imageTokens,preflightMs,ok:true});
  }
  const parallel=await Promise.all(Array.from({length:4},()=>client.countChatInputTokens(two,provider.credential.token)));
  required(parallel.every(count=>count.imageTokens===288 && count.promptTokens===twoCount.promptTokens),"parallel counts failed");results.push({case:"four-parallel-counts",ok:true});
  const wrong=[
    ["external-url",bodyFor(provider.model,[{type:"image_url",image_url:{url:"https://private.invalid/image.png"}}]),400,"image_reference_unsupported"],
    ["mime-mismatch",bodyFor(provider.model,[image(red,"image/jpeg")]),415,"image_mime_mismatch"],
    ["image-count",bodyFor(provider.model,Array.from({length:9},()=>image(red))),413,"image_count_exceeded"],
    ["corrupt-image",bodyFor(provider.model,[image(red.subarray(0,33))]),422,"image_invalid"],
  ] as const;
  for(const [name,body,status,code] of wrong){try{await client.countChatInputTokens(body,provider.credential.token);throw new Error("invalid image accepted");}catch(error){required(error instanceof LarmApiError && error.status===status && error.code===code,`error contract ${name}`);}results.push({case:name,status,code,ok:true});}
  const large={model:provider.model,max_tokens:128,messages:[{role:"user",content:"a ".repeat(270000)}]};
  const largeCount=await client.countChatInputTokens(large,provider.credential.token);required(!largeCount.fits,"excessive context accepted");
  const refused=await fetch(provider.baseUrl+"/chat/completions",{method:"POST",headers:{authorization:`Bearer ${provider.credential.token}`,"content-type":"application/json"},body:JSON.stringify(large)});
  required(refused.status===400 && (await refused.json() as {error:{code:string}}).error.code==="context_budget_exceeded","excessive generation forwarded");results.push({case:"context-budget",promptTokens:largeCount.promptTokens,ok:true});
  await client.renewAgentConnection(main.connection.id,600);
  const renewed=await client.claimAgentConnection(main.connection.id);const newer=renewed.providers.find(p=>p.name==="llm");if(!newer || newer.protocol!=="openai.chat-completions.v1")throw new Error("reclaim lacks LLM");provider=newer;
  required((await client.countChatInputTokens(two,provider.credential.token)).imageTokens===288,"renew and reclaim failed");results.push({case:"renew-reclaim",ok:true});
  const background=await connect("contextStill");const bgBody=bodyFor(background.provider.model,[text("Identify the dominant color. Return JSON with color."),image(blue)]);const bgCount=await client.countChatInputTokens(bgBody,background.provider.credential.token);
  const bgReply=await (await infer(background.provider,bgBody)).json() as {usage:{prompt_tokens:number};choices:Array<{message:{content:string}}>};required(JSON.parse(bgReply.choices[0]!.message.content).color==="blue" && bgCount.promptTokens===bgReply.usage.prompt_tokens,"ContextStill image inference failed");results.push({case:"contextStill",maxContextTokens:bgCount.maxContextTokens,ok:true});
  const report={ok:true,observedAt:new Date().toISOString(),releaseCommit:health.releaseCommit,configRevision:health.configRevision,results};
  if(process.env.LARM_IMAGE_SMOKE_REPORT)await writeFile(process.env.LARM_IMAGE_SMOKE_REPORT,JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({ok:true,tests:results.length,releaseCommit:health.releaseCommit}));
} finally {for(const id of owned)await client.releaseAgentConnection(id);}
