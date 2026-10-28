import argparse,json,time,subprocess,os,signal,urllib.request,statistics,socket,pathlib,sys
parser=argparse.ArgumentParser()
parser.add_argument('output', nargs='?', default='/srv/ai/evidence/lfm3-reasoning-budget-20261028')
parser.add_argument('--native-off-only', action='store_true')
args=parser.parse_args()
root=pathlib.Path(args.output);root.mkdir(parents=True,exist_ok=False)
engine='/srv/ai/apps/llama-lfm3-benchmark/build-vulkan/bin/llama-server';weights='/srv/ai/models/lfm3-1.7b-gguf/LFM3-1.7B-QAD-Q4_0.gguf'
prompt='数字0、1、2、3、4、5から異なる3つを使って3桁の整数を作ります。5で割り切れる整数は何個ですか。場合分けして日本語で説明してください。'
results={'prompt':prompt,'max_tokens':4096,'temperature':0.1,'top_k':50,'top_p':1.0,'min_p':0.0,'repeat_penalty':1.05,'seed':'20261015 + iteration','started':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'notes':'direct backend; LFM3 restarted for each startup reasoning budget while resident Ornith stays loaded','samples':[]}
def save(): (root/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
def chat(origin,model,iteration,level,budget):
 payload={'model':model,'messages':[{'role':'user','content':prompt}],'max_tokens':4096,'temperature':0.1,'top_k':50,'top_p':1.0,'min_p':0.0,'repeat_penalty':1.05,'seed':20261015+iteration,'stream':True,'stream_options':{'include_usage':True},'chat_template_kwargs':{'enable_thinking':level!='none'},'cache_prompt':False}
 req=urllib.request.Request(origin+'/v1/chat/completions',json.dumps(payload,ensure_ascii=False).encode(),{'Content-Type':'application/json'}); start=time.monotonic(); reason='';content='';first_reason=None;first_content=None;usage=None;timings=None;finish=None;done=False
 with urllib.request.urlopen(req,timeout=180) as resp:
  for line in resp:
   if not line.startswith(b'data:'): continue
   data=line[5:].strip()
   if data==b'[DONE]': done=True; break
   chunk=json.loads(data)
   if chunk.get('error'): raise RuntimeError(str(chunk['error']))
   choice=(chunk.get('choices') or [{}])[0];d=choice.get('delta',{});t=(time.monotonic()-start)*1000
   r=d.get('reasoning_content') or d.get('reasoning') or '';c=d.get('content') or ''
   if r and first_reason is None: first_reason=t
   if c.strip() and first_content is None: first_content=t
   reason+=r;content+=c;finish=choice.get('finish_reason') or finish;usage=chunk.get('usage') or usage;timings=chunk.get('timings') or timings
 row={'model':model,'iteration':iteration,'level':level,'requestedBudget':budget,'firstReasonMs':first_reason,'firstContentMs':first_content,'totalMs':(time.monotonic()-start)*1000,'reasoningChars':len(reason),'reasoning':reason,'content':content,'finish':finish,'done':done,'usage':usage,'timings':timings}
 results['samples'].append(row);save();print(json.dumps({k:v for k,v in row.items() if k not in ('reasoning','content')},ensure_ascii=False),flush=True)
 if not done or not finish: raise RuntimeError('incomplete SSE')
levels=[('none',-1)] if args.native_off_only else [('none',0),('low',64),('medium',256),('high',512),('max',-1)]
results['conditions']=levels;results['runs']=[]
for level,budget in levels:
 with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
 cmd=[engine,'-m',weights,'--alias','lfm3-reasoning','-dev','Vulkan0','-ngl','999','--fit','off','--flash-attn','on','--ctx-size','8192','--parallel','1','--batch-size','2048','--ubatch-size','512','--threads','16','--cache-type-k','q4_0','--cache-type-v','q4_0','--host','127.0.0.1','--port',str(port),'--reasoning','off' if level=='none' else 'on','--reasoning-format','deepseek','--reasoning-budget',str(budget),'--jinja','--metrics','--no-webui']
 run={'level':level,'command':cmd};results['runs'].append(run);save();log=(root/f'lfm-{level}.log').open('w');proc=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);origin=f'http://127.0.0.1:{port}'
 try:
  deadline=time.monotonic()+240
  while time.monotonic()<deadline:
   if proc.poll() is not None: raise RuntimeError(f'LFM exited {proc.returncode}')
   try:
    with urllib.request.urlopen(origin+'/health',timeout=2) as r:
     if json.load(r).get('status')=='ok': break
   except Exception: pass
   time.sleep(1)
  else: raise TimeoutError('LFM readiness timeout')
  with urllib.request.urlopen(origin+'/props',timeout=10) as r: (root/f'lfm-{level}-props.json').write_text(json.dumps(json.load(r),ensure_ascii=False,indent=2))
  print('ready',level,flush=True)
  for i in range(1,3):
   chat(origin,'lfm3-reasoning',i,level,budget)
   row=results['samples'][-1]
   req=urllib.request.Request(origin+'/tokenize',json.dumps({'content':row['reasoning'],'add_special':False},ensure_ascii=False).encode(),{'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=10) as response: row['reasoningRetokenized']=len(json.load(response)['tokens'])
   save();print('thinking_tokens',level,i,row['reasoningRetokenized'],flush=True)
 finally:
  try: os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=20)
  except ProcessLookupError: pass
  except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
  log.close();run['exitCode']=proc.returncode;save()
