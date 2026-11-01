import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { LarmClient as ClientType } from "../../../packages/client/src/index";
import { resolve } from "node:path";
import { agentProfileSelectorIdSchema } from "../../../packages/core/src/index";
// Use the deployed client contract and resolved live Ornith route. All prompts
// are synthetic; never reset another consumer's connection or cache.
const deployedClient = "/srv/ai/apps/larm-current/packages/client/src/index.ts";
const { LarmClient } = await import(deployedClient) as { LarmClient: typeof ClientType };
const output=Bun.argv[2], profile=agentProfileSelectorIdSchema.parse(Bun.argv[3]??"lfm2.5");
if(!output || !process.env.EXPECTED_RELEASE || !process.env.LARM_PROMPT_RETENTION_ENV_FILE) {
  throw new Error("usage: EXPECTED_RELEASE=COMMIT LARM_PROMPT_RETENTION_ENV_FILE=PRIVATE_ENV bun verify-ornith-media-coexist.ts EVIDENCE_DIR [PROFILE]");
}
const root=resolve(output);mkdirSync(root,{recursive:true});
const imageSize=Number(process.env.LARM_E2E_IMAGE_SIZE??1024);
if(!Number.isInteger(imageSize)||imageSize<100||imageSize>1280)throw new Error("invalid E2E image size");
const env=Object.fromEntries(readFileSync('/etc/larm/larm.env','utf8').split('\n').filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
const privateEnv=JSON.parse(readFileSync(process.env.LARM_PROMPT_RETENTION_ENV_FILE,'utf8'));
const base='http://127.0.0.1:9810', headers={authorization:`Bearer ${env.LARM_API_TOKEN}`,'content-type':'application/json'};
const client=new LarmClient({baseUrl:base,apiToken:env.LARM_API_TOKEN,timeoutMs:300000});
const owned:string[]=[], providers:any[]=[]; const run=`live-memory-${Date.now()}`;
const result:any={ok:false,startedAt:new Date().toISOString(),cases:[],samples:[],cleanup:[]};
const save=()=>writeFileSync(`${root}/results.json`,JSON.stringify(result,null,2)+'\n');
const check=(v:unknown,reason:string)=>{if(!v)throw new Error(reason);};
const json=async(path:string)=>{const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(10000)});check(r.ok,`inspection_http_${r.status}`);return r.json() as any;};
let sampling=false, stopped=false; let native=''; let imageActive=false;
async function sample(){if(sampling||stopped)return;sampling=true;try{
 const mem=Object.fromEntries([...readFileSync('/proc/meminfo','utf8').matchAll(/^(\w+):\s+(\d+) kB/gm)].map(m=>[m[1],Number(m[2])*1024]));
 const response=await fetch(native+'/metrics',{signal:AbortSignal.timeout(1000)});const wire=await response.text();
 const processing=Number(/(?:^|\n)(?:llamacpp:)?requests_processing\s+(\d+)/.exec(wire)?.[1]??-1);
 let acceleratorAvailable=0;
 for(const card of readdirSync('/sys/class/drm').filter(c=>/^card[0-9]+$/.test(c))){try{
 const dir=`/sys/class/drm/${card}/device/`;const read=(n:string)=>Number(readFileSync(dir+n,'utf8').trim());
 acceleratorAvailable+=read('mem_info_vram_total')+read('mem_info_gtt_total')-read('mem_info_vram_used')-read('mem_info_gtt_used');
 }catch{}}
 const row:any={at:Date.now(),systemAvailable:mem.MemAvailable,acceleratorAvailable,processing};
 const child=Bun.spawn(['systemctl','show','larm-image-qwen21.service','-p','MainPID','--value'],{stdout:'pipe',stderr:'ignore'});
 row.imagePid=Number((await new Response(child.stdout).text()).trim());await child.exited;
 if(row.imagePid>0)imageActive=true;
 result.samples.push(row);
 }catch{result.sampleErrors=(result.sampleErrors??0)+1;}finally{sampling=false;}}
async function chat(lane:number,stream:boolean,round:string,probe=false){const p=providers[lane];const start=Date.now();
 const marker=['cobalt','amber','jade'][lane];const prefix=Array.from({length:180},(_,i)=>`Record ${lane}-${i}: this synthetic independent session keeps its own marker and context during image generation.`).join('\n');
 const body={model:p.model,messages:[{role:'system',content:`${prefix}\nYour marker is ${marker}.`},{role:'user',content:probe?`Return only your marker word, with no explanation.`:`Start with ${marker}, then give a long numbered list of short descriptions of geometric shapes.`}],max_tokens:probe?32:256,temperature:0,seed:42,stream,stream_options:stream?{include_usage:true}:undefined,prompt_cache_key:`${run}-${lane}`};
 const r=await fetch(p.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${p.credential.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
 let content='',finish:any,usage:any,done=!stream;
 if(stream){const wire=await r.text();done=wire.includes('data: [DONE]');for(const line of wire.split(/\r?\n/)){if(!line.startsWith('data: {'))continue;const data=JSON.parse(line.slice(6));check(!data.error,'sse_error');content+=data.choices?.[0]?.delta?.content??'';finish=data.choices?.[0]?.finish_reason??finish;usage=data.usage??usage;}}
 else{const data:any=await r.json();content=data.choices?.[0]?.message?.content??'';finish=data.choices?.[0]?.finish_reason;usage=data.usage;}
 // Retain synthetic text to diagnose instruction omissions independently of resource failures.
 writeFileSync(`${root}/chat-${round}-${lane}.txt`,content);
 const row={kind:probe?'semantic-probe':'chat',round,lane,stream,status:r.status,ms:Date.now()-start,finish,markerMatched:content.toLowerCase().includes(marker),contentChars:content.length,promptTokens:usage?.prompt_tokens,cachedTokens:usage?.prompt_tokens_details?.cached_tokens};result.cases.push(row);save();console.log(JSON.stringify(row));
 check(r.ok&&content.length>0&&done&&['stop','length'].includes(finish),`chat_${lane}_failed`);if(probe){check(row.markerMatched&&finish==='stop',`probe_${lane}_marker_mismatch`);check(!['cobalt','amber','jade'].filter(x=>x!==marker).some(x=>content.toLowerCase().includes(x)),`probe_${lane}_cross_session_marker`);}
}
async function image(model:string,size:number){const start=Date.now();const r=await fetch(base+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify({model,prompt:'A small red wooden sailboat on a quiet blue lake, soft daylight, no letters or text.',width:size,height:size,seed:91273,format:'png'}),signal:AbortSignal.timeout(900000)});
 const data:any=await r.json();const row:any={kind:'image',model,size,status:r.status,ms:Date.now()-start,errorCode:data.error?.code};result.cases.push(row);save();check(r.ok&&data.status==='succeeded',`image_http_${r.status}_${data.error?.code??'unknown'}`);
 const a=data.artifact;const content=await fetch(base+a.contentUrl,{headers,signal:AbortSignal.timeout(10000)});const bytes=new Uint8Array(await content.arrayBuffer());row.artifact=a.id;row.sha256=createHash('sha256').update(bytes).digest('hex');row.bytes=bytes.length;row.hashMatches=row.sha256===a.sha256;check(content.ok&&row.hashMatches&&bytes.length===a.bytes,'image_hash_failed');check(bytes[0]===137&&bytes[1]===80&&a.width===size&&a.height===size,'image_format_failed');writeFileSync(`${root}/${model}-${size}.png`,bytes);
 const child=Bun.spawn(['systemctl','show','larm-image-qwen21.service','-p','MainPID','-p','ActiveState'],{stdout:'pipe',stderr:'ignore'});row.worker=(await new Response(child.stdout).text()).trim();await child.exited;check(row.worker.includes('MainPID=0')&&row.worker.includes('ActiveState=inactive'),'image_worker_not_stopped');save();console.log(JSON.stringify(row));return row;}
let timer:ReturnType<typeof setInterval>|undefined;
try{
 result.healthBefore=await json('/health');check(result.healthBefore.releaseCommit===process.env.EXPECTED_RELEASE,'release_mismatch');
 const catalog=await client.listAgentProfilesV3(profile);result.catalogRevision=catalog.catalogRevision;
 for(let lane=0;lane<3;lane++){const c=await client.createAgentConnection({profile,audience:'same-host',providers:['llm'],client:`${run}-${lane}`,contextTokens:lane===0?200000:131072,ttlSeconds:1800,allowFallback:false,deploymentPolicy:'existing-only',expectedCatalogRevision:catalog.catalogRevision});owned.push(c.id);await client.waitForAgentConnection(c,{timeoutMs:120000});const claim=await client.claimAgentConnection(c.id);const p:any=claim.providers.find((x:any)=>x.name==='llm');check(p?.model==='ornith1.5-strix'&&p.apiStyle==='openai','profile_does_not_resolve_to_ornith');check(p?.contextWindow?.maxTokens===(lane===0?200000:131072),'context_claim_mismatch');providers.push(p);result.cases.push({kind:'connection',lane,context:p.contextWindow.maxTokens,model:p.model});save();}
 const running:any=await (await fetch('http://127.0.0.1:8083/running')).json();const live=running.running.find((x:any)=>x.model==='ornith15-strix-conversation');check(live,'ornith_not_running');const u=new URL(live.proxy);check(['127.0.0.1','localhost'].includes(u.hostname)&&u.protocol==='http:','invalid_native_origin');native=u.origin;
 result.runtime='ornith15-strix-conversation';
 timer=setInterval(()=>void sample(),200);await sample();
 for(const [model,size] of [['qwen-image-2.1-turbo',imageSize],['flux-3-image-klein',imageSize]] as const){
  imageActive=false;let imageDone=false;
  const imageStart=Date.now();const pending=image(model,size).then(value=>{imageDone=true;return {value};},error=>{imageDone=true;return {error};});
  while(!imageActive&&!imageDone&&Date.now()-imageStart<15000)await Bun.sleep(100);
  check(imageActive,'image_did_not_start_promptly');
  result.cases.push({kind:'startup',model,workerObservedMs:Date.now()-imageStart});save();
  const settled=await Promise.allSettled([chat(0,false,model),chat(1,true,model),chat(2,false,model)]);
  const outcome=await pending;if('error' in outcome)throw outcome.error;
  const failed=settled.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  const samples=result.samples.filter((x:any)=>x.at>=imageStart);check(samples.some((x:any)=>x.processing>=3&&x.imagePid>0),'three_sessions_not_observed_during_image');
  const probes=await Promise.allSettled([chat(0,false,model+'-probe',true),chat(1,true,model+'-probe',true),chat(2,false,model+'-probe',true)]);
  const badProbe=probes.find(x=>x.status==='rejected');if(badProbe?.status==='rejected')throw badProbe.reason;
  result.cases.push({kind:'coexist',model,maxConcurrent:Math.max(...samples.map((x:any)=>x.processing)),minSystemAvailable:Math.min(...samples.map((x:any)=>x.systemAvailable)),minAcceleratorAvailable:Math.min(...samples.map((x:any)=>x.acceleratorAvailable))});save();
 }
 const finalSettled=await Promise.allSettled([chat(0,true,'after-images'),chat(1,false,'after-images'),chat(2,true,'after-images')]);
 const finalFailure=finalSettled.find(x=>x.status==='rejected');if(finalFailure?.status==='rejected')throw finalFailure.reason;
 const postProbes=await Promise.allSettled([chat(0,true,'final-probe',true),chat(1,false,'final-probe',true),chat(2,true,'final-probe',true)]);
 const badPost=postProbes.find(x=>x.status==='rejected');if(badPost?.status==='rejected')throw badPost.reason;
 const stats=await fetch(native+'/larm/cache/invalidate',{method:'POST',headers:{'content-type':'application/json','x-larm-cache-key':privateEnv.LARM_PROMPT_CACHE_KEY},body:'{"action":"inspect"}'});const cache:any=await stats.json();result.nativeFinal={onDemandKv:cache.onDemandKv,entries:cache.entries,bytes:cache.bytes};check(cache.onDemandKv?.failures===0,'kv_resize_failed');
 result.ok=true;
}catch(error){result.error=error instanceof Error?error.message:'verification_failed';console.error(result.error);}
finally{
 stopped=true;if(timer)clearInterval(timer);
 for(const id of owned){try{await client.releaseAgentConnection(id);result.cleanup.push({connection:id,released:true});}catch{result.cleanup.push({connection:id,released:false});result.ok=false;}}
 result.endedAt=new Date().toISOString();save();
}
if(!result.ok)process.exit(1);
