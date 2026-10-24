#!/usr/bin/env bash
# Local-only measurement glue; never changes services, drivers or model files.
# Deferred 2026-10-24: run only after the separate Strix restart validation has ended.
# The automatic idle guard does not establish that all background work has ended.
set -euo pipefail
if [[ ${1:-} != --run ]]; then
  echo 'Usage: ORNITH_OUTPUT=/absolute/new/directory bash ornith-mtp-reproduce.sh --run A|A1|B1|B2|C0|C1|C2|C2S|C3|C3S|F|E0|E3|EN|R0|R2S'
  echo 'A: live baseline; A1: isolated baseline; B: old head; C: refreshed file; F: ngram-mod.'
  echo 'Deferred: confirm separate Strix restart testing has ended before starting a new measurement.'
  exit 0
fi
export ORNITH_CASE=${2:?select a case}
export ORNITH_REPO_ROOT
ORNITH_REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 - <<'PY'
import csv, datetime, hashlib, json, os, pathlib, re, signal, socket, statistics, subprocess, sys, threading, time, urllib.request

case = os.environ['ORNITH_CASE']
temperature=float(os.environ.get('ORNITH_TEMPERATURE','0'))
if not 0<=temperature<=2: raise SystemExit('Temperature outside 0..2')
iterations=int(os.environ.get('ORNITH_TRIALS','3'))
if not 1<=iterations<=3: raise SystemExit('Trials must be 1..3')
different_warmup=os.environ.get('ORNITH_DIFFERENT_WARMUP')=='1'
if case not in ('A','A1','B1','B2','C0','C1','C2','C2S','C3','C3S','F','E0','E3','EN','R0','R2S'): raise SystemExit('Unknown case')
hipfire=case.startswith('E')
def interrupted(signum, frame): raise RuntimeError(f'Interrupted by signal {signum}')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
out = pathlib.Path(os.environ['ORNITH_OUTPUT'])
repo = pathlib.Path(os.environ['ORNITH_REPO_ROOT']).resolve()
if not out.is_absolute() or out.resolve().is_relative_to(repo): raise SystemExit('Output must be absolute and outside repository')
out.mkdir(mode=0o700, parents=True, exist_ok=False)
base_port = int(os.environ.get('ORNITH_PORT','18091'))
port = 58009 if case == 'A' else base_port
url = f'http://127.0.0.1:{port}'
server = None
stop = threading.Event()
conflict = []
telemetry = []
guard_ports = set()
live_pid = None
hw = pathlib.Path('/sys/class/drm/card1/device')
def read(p):
    try: return pathlib.Path(p).read_text().strip()
    except OSError: return ''
def available(): return int(re.search(r'MemAvailable:\s+(\d+)', read('/proc/meminfo'))[1])*1024
def drm_stats(pid):
    result={};seen=set()
    for path in pathlib.Path(f'/proc/{pid}/fdinfo').glob('*'):
        data=read(path)
        if 'drm-client-id:' not in data: continue
        fields=dict(re.findall(r'^(drm-[^:]+):\s*(.*)$',data,re.M))
        client=(fields.get('drm-pdev'),fields.get('drm-client-id'))
        if client in seen: continue
        seen.add(client)
        for k in ('drm-resident-gtt','drm-resident-vram','drm-engine-compute'):
            if k not in fields: continue
            parts=fields[k].split();v=int(parts[0]);unit=parts[1] if len(parts)>1 else ''
            v*=1024 if unit=='KiB' else 1024**2 if unit=='MiB' else 1
            result[k]=result.get(k,0)+v
    return result
def api(path, body=None, target=url, timeout=5):
    data = None if body is None else json.dumps(body,ensure_ascii=False).encode()
    req = urllib.request.Request(target+path, data=data, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as r: return json.load(r)
def metrics(p):
    with urllib.request.urlopen(f'http://127.0.0.1:{p}/metrics',timeout=2) as r: s=r.read().decode()
    return {k:float(v) for k,v in re.findall(r'^(llamacpp:[\w_]+) ([^\s]+)',s,re.M)}
def discover():
    s=subprocess.check_output(['ss','-ltnp'],text=True)
    return {int(m[1]) for l in s.splitlines() if 'llama-server' in l for m in [re.search(r'127\.0\.0\.1:(\d+)',l)] if m and int(m[1])!=port}
def signature(m): return tuple(m.get('llamacpp:'+k,0) for k in ('prompt_tokens_total','tokens_predicted_total','requests_processing','requests_deferred'))
def check_idle():
    for p in guard_ports:
        m=metrics(p)
        if m.get('llamacpp:requests_processing',0) or m.get('llamacpp:requests_deferred',0): raise RuntimeError(f'Competing request on port {p}')
    if available()<24*1024**3: raise RuntimeError('Available RAM below 24 GiB reserve')
def monitor():
    try: previous={p:signature(metrics(p)) for p in guard_ports}
    except Exception as e: conflict.append(str(e)); return
    while not stop.wait(0.5):
        try:
            check_idle()
            if case=='A' and metrics(port).get('llamacpp:requests_processing',0)>1: raise RuntimeError('Another request entered live baseline')
            for p in guard_ports:
                if signature(metrics(p)) != previous[p]: raise RuntimeError(f'Competing activity or restart on port {p}')
            if discover()!=guard_ports: raise RuntimeError('Competing engine set changed')
            pid=server.pid if server else live_pid
            if hipfire and server:
                children=read(f'/proc/{server.pid}/task/{server.pid}/children').split()
                if children: pid=int(children[0])
            status=read(f'/proc/{pid}/status')
            hws=list(hw.glob('hwmon/hwmon*'))
            h=hws[0] if hws else hw/'missing'
            telemetry.append({'unix_s':time.time(),'available_bytes':available(),'rss_kib':int(re.search(r'VmRSS:\s+(\d+)',status)[1]) if 'VmRSS:' in status else None,'process_stat':read(f'/proc/{pid}/stat'),'gpu_busy_raw':read(hw/'gpu_busy_percent'),'gtt_bytes':read(hw/'mem_info_gtt_used'),'vram_bytes':read(hw/'mem_info_vram_used'),'temp_mC':read(h/'temp1_input'),'power_uW':read(h/'power1_average') or read(h/'power1_input')})
            telemetry[-1].update(drm_stats(pid))
        except Exception as e:
            conflict.append(str(e))
            if server and server.poll() is None: os.killpg(server.pid,signal.SIGTERM)
            return
def ensure():
    if conflict: raise RuntimeError(conflict[0])
def stream(body, name):
    ensure(); check_idle()
    sample_start=len(telemetry)
    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (out/(name+'-request.json')).write_text(json.dumps(body,ensure_ascii=False,indent=2))
    before=metrics(port); t0=time.perf_counter(); first=None; events=[]; content=''; tools=[]; result={}
    req=urllib.request.Request(url+'/v1/chat/completions',data=json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=240) as r:
            for line in r:
                ensure()
                if not line.startswith(b'data: '): continue
                raw=line[6:].strip()
                if raw==b'[DONE]': break
                e=json.loads(raw); events.append(e)
                if e.get('error'): raise RuntimeError(str(e['error']))
                result.update({k:e[k] for k in ('usage','timings','hipfire') if k in e})
                for c in e.get('choices',[]):
                    d=c.get('delta',{}); text=d.get('content') or ''; reasoning=d.get('reasoning_content') or ''
                    if (text or reasoning or d.get('tool_calls')) and first is None: first=time.perf_counter()-t0
                    content+=text; tools.extend(d.get('tool_calls',[]))
                    if c.get('finish_reason'): result['finish_reason']=c['finish_reason']
        ensure(); after=metrics(port)
        delta={k:after.get(k,0)-v for k,v in before.items()}
        def metric(k): return delta.get('llamacpp:'+k)
        timing=result.get('timings',{}); usage=result.get('usage',{})
        n=timing.get('predicted_n',metric('tokens_predicted_total')); sec=timing.get('predicted_ms',0)/1000 or metric('tokens_predicted_seconds_total'); pn=timing.get('prompt_n',metric('prompt_tokens_total')); ps=timing.get('prompt_ms',0)/1000 or metric('prompt_seconds_total')
        if hipfire: n=usage.get('completion_tokens');pn=usage.get('prompt_tokens')
        row={'case':case,'scenario':name.rsplit('-',1)[0],'trial':name.rsplit('-',1)[-1],'status':'ok','context_capacity_per_slot':262144 if case=='A' else 65536,'prompt_tokens_evaluated':pn,'completion_tokens':n,'decode_tps':n/sec if sec and n else None,'prefill_tps':pn/ps if ps and pn else None,'ttft_ms':first*1000 if first is not None else None,'e2e_ms':(time.perf_counter()-t0)*1000,'draft_tokens':metric('spec_decode_num_draft_tokens_total'),'accepted_draft_tokens':metric('spec_decode_num_accepted_tokens_total'),'finish_reason':result.get('finish_reason'),'json_valid':None,'tool_valid':None,'eligible_speed':bool(n and n>=128),'error':''}
        row['cached_tokens']=timing.get('cache_n',usage.get('prompt_tokens_details',{}).get('cached_tokens'))
        row['timestamp_utc']=timestamp
        row['temperature']=temperature
        if hipfire:
            row['decode_tps']=timing.get('decode_tok_s');row['prefill_tps']=timing.get('prefill_tok_s')
            row['spec_tau']=timing.get('tau');row['spec_mtp']=timing.get('mtp');row['spec_ngram']=timing.get('mtp_ngram')
            for k in ('ngram_mod_drafts','ngram_mod_accepted','ngram_mod_accept_rate'): row[k]=timing.get(k)
        if row['cached_tokens']: row['eligible_speed']=False
        row['draft_tokens']=timing.get('draft_n',row['draft_tokens']);row['accepted_draft_tokens']=timing.get('draft_n_accepted',row['accepted_draft_tokens'])
        row['draft_acceptance']=row['accepted_draft_tokens']/row['draft_tokens'] if row['draft_tokens'] else None
        row['mtp_acceptance']=row['draft_acceptance'] if case!='F' else None
        row['ngram_acceptance']=row['draft_acceptance'] if case=='F' else None
        row['draft_history']='fresh-process/different-warmup' if different_warmup else 'shared-process/repeated-prompt'
        samples=telemetry[sample_start:]
        for key in ('rss_kib','gtt_bytes','vram_bytes','temp_mC','power_uW','gpu_busy_raw','drm-resident-gtt','drm-resident-vram'):
            vals=[float(s[key]) for s in samples if s.get(key) is not None and str(s[key])!='']
            row[key+'_peak']=max(vals) if vals else None
            row[key+'_mean']=statistics.mean(vals) if vals else None
        if len(samples)>1:
            def ticks(s):
                fields=s['process_stat'].rsplit(')',1)[1].split();return int(fields[11])+int(fields[12])
            row['cpu_percent_mean']=100*(ticks(samples[-1])-ticks(samples[0]))/os.sysconf('SC_CLK_TCK')/(samples[-1]['unix_s']-samples[0]['unix_s'])
            if not hipfire and 'drm-engine-compute' in samples[0] and 'drm-engine-compute' in samples[-1]:
                delta=samples[-1]['drm-engine-compute']-samples[0]['drm-engine-compute']
                if delta>=0: row['gpu_compute_active_percent']=100*delta/1e9/(samples[-1]['unix_s']-samples[0]['unix_s'])
        if 'json' in name:
            try:
                o=json.loads(content); row['json_valid']=set(o)=={'city','activities'} and o['city']=='京都' and isinstance(o['activities'],list) and len(o['activities'])==3 and all(isinstance(x,str) for x in o['activities'])
            except Exception: row['json_valid']=False
        if 'tool' in name:
            call={}
            for t in tools:
                f=t.get('function',{}); call['name']=call.get('name','')+f.get('name','');call['arguments']=call.get('arguments','')+f.get('arguments','')
            try: row['tool_valid']=call['name']=='get_weather' and json.loads(call['arguments'])=={'city':'京都','date':'2026-10-25'}
            except Exception: row['tool_valid']=False
        result.update(content=content,tool_deltas=tools,metric_delta=delta,events=events)
        (out/(name+'-response.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
        return row
    except Exception as e:
        (out/(name+'-partial.json')).write_text(json.dumps({'error':str(e),'events':events},ensure_ascii=False,indent=2)); raise

rows=[]
try:
    guard_ports=discover(); check_idle()
    # Require a quiet observation window before adding any inference load.
    sig={p:signature(metrics(p)) for p in guard_ports}
    for _ in range(5):
        time.sleep(1); check_idle()
        if discover()!=guard_ports or any(signature(metrics(p))!=sig[p] for p in guard_ports): raise RuntimeError('Competing engine changed during quiet window')
    if case!='A':
        if available()<46*1024**3: raise RuntimeError('Need 46 GiB available before separate model load')
        gtt_free=int(read(hw/'mem_info_gtt_total'))-int(read(hw/'mem_info_gtt_used'))
        if gtt_free<30*1024**3: raise RuntimeError('Need 30 GiB free GTT before separate model load')
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            s.bind(('127.0.0.1',port))
        engine='/srv/ai/apps/larm-chat-input-engine-20261022-prefix-v1/llama-server'
        model='/srv/ai/models/ornith-trial-20261012/strix-lean/Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf'
        if case[0] in 'CR': model='/srv/ai/models/halofpx/ornith-1.5-35b/Ornith-1.5-35B-A3B-ROCmFP4.gguf'
        if case.startswith('R'): engine='/srv/ai/apps/ornith-mtp-trial-20261024/rocmfpx-v1.7.0/unpacked/strix-halo-rocmfpx-engine/bin/llama-server'
        spec='draft-mtp' if case[0] in 'BCR' and case[1]!='0' else ('ngram-mod' if case=='F' else 'none')
        args=[engine,'-m',model,'-dev','Vulkan0','-ngl','999','--fit','off','--no-mmap','--flash-attn','on','--ctx-size','65536','--parallel','1','--batch-size','2048','--ubatch-size','512','--threads','16','--poll','100','--cache-type-k','q4_0','--cache-type-v','q4_0','--kv-unified','--host','127.0.0.1','--port',str(port),'--reasoning','off','--spec-type',spec,'-ctxcp','0','-cram','0','--no-cache-idle-slots','--no-cache-prompt','--jinja','--no-context-shift','--metrics','--no-webui']
        if spec=='draft-mtp': args+=['--spec-draft-device','Vulkan0','--spec-draft-n-max',case[1],'--spec-draft-p-min','0.6']
        if case.endswith('S'): args+=['--spec-mtp-strict-qwen']
        if hipfire:
            trial_root=pathlib.Path(os.environ.get('ORNITH_HIPFIRE_ROOT','/srv/ai/apps/ornith-mtp-trial-20261024'))
            model=str(trial_root/'models/ornith-1.5-35b-a3b.mq4')
            if not pathlib.Path(model).is_file(): raise RuntimeError('Verified hipfire model not installed')
            args=[str(trial_root/'hipfire/target/release/hipfire'),'serve',model,'127.0.0.1',str(port),'--max-seq','65536','--kv-mode','q8','--spec','off' if case=='E0' else 'mtp','--idle-timeout','0']
        (out/'launch.json').write_text(json.dumps(args,indent=2))
        env=os.environ.copy();env.update(HIP_VISIBLE_DEVICES='-1',ROCR_VISIBLE_DEVICES='-1')
        if hipfire:
            env.pop('HIP_VISIBLE_DEVICES',None);env.pop('ROCR_VISIBLE_DEVICES',None)
            env.update(HIPFIRE_HOME=str(trial_root/'home'),HIPFIRE_KERNEL_CACHE=str(trial_root/'kernel-cache'),HIPFIRE_ROCM_PATH='/opt/rocm',HIPFIRE_SESSION_CACHE_BYTES='0',HIPFIRE_MTP_K='3',HIPFIRE_MTP_NGRAM='1' if case=='EN' else '0',HIPFIRE_JIT_JOBS='2')
        server=subprocess.Popen(args,env=env,stdout=(out/'server.log').open('w'),stderr=subprocess.STDOUT,start_new_session=True)
    if case=='A':
        listeners=subprocess.check_output(['ss','-ltnp'],text=True)
        line=next(l for l in listeners.splitlines() if f'127.0.0.1:{port} ' in l and 'llama-server' in l)
        live_pid=int(re.search(r'pid=(\d+)',line)[1])
    watcher=threading.Thread(target=monitor,daemon=True);watcher.start()
    for _ in range(240):
        ensure()
        if server and server.poll() is not None: raise RuntimeError('Test engine exited; inspect server.log')
        try: api('/health');break
        except Exception: time.sleep(.5)
    props=api('/health' if hipfire else '/props');(out/'props.json').write_text(json.dumps(props,ensure_ascii=False,indent=2))
    if case=='A':
        if props.get('model_path')!='/srv/ai/models/ornith-trial-20261012/strix-lean/Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf': raise RuntimeError('Live port resolves to a different model; refusing inference')
    standard={'model':model if hipfire else props.get('model_alias','ornith'),'stream':True,'stream_options':{'include_usage':True},'temperature':temperature,'top_p':.95,'top_k':64,'min_p':.05,'repeat_penalty':1,'presence_penalty':0,'frequency_penalty':0,'seed':20261024,'cache_prompt':False,'chat_template_kwargs':{'enable_thinking':False}}
    scenarios=[('ja-chat','今日は少し疲れました。明日は休みなので、家でゆっくり過ごしたいです。料理と散歩を少し取り入れて、無理のない休日の過ごし方を、自然な日本語で提案してください。気持ちに寄り添いながら、朝昼晩それぞれの楽しみを具体的に教えてください。',384,{}),('ja-long','家庭のベランダで初めて野菜を育てる人向けに、土、鉢、種まき、水やり、虫対策、収穫までを具体例つきで詳しく説明してください。最低1600字の自然な日本語で書いてください。',1024,{}),('en-long','Write a detailed practical guide to starting a community garden. Cover planning, soil, watering, shared responsibilities, seasonal maintenance and conflict resolution. Write at least 900 words.',1024,{}),('typescript','Write a complete TypeScript LRU cache class with get, put, delete, resize and iteration from newest to oldest. Include invariants, edge cases and usage examples.',768,{}),('json','京都で休日にできる活動を3つ挙げてください。cityは京都、activitiesは3つの文字列にしてください。JSONだけを返してください。',256,{'response_format':{'type':'json_schema','json_schema':{'name':'holiday','strict':True,'schema':{'type':'object','properties':{'city':{'type':'string','enum':['京都']},'activities':{'type':'array','items':{'type':'string'},'minItems':3,'maxItems':3}},'required':['city','activities'],'additionalProperties':False}}}}),('reasoning','A、B、Cの3人が順番に発表します。Aは最初ではなく、BはCより前です。可能な順序をすべて列挙して、条件を一つずつ確認してください。',512,{}),('tool','京都の2026年10月25日の天気をget_weatherで調べてください。',128,{'tools':[{'type':'function','function':{'name':'get_weather','description':'指定した都市と日付の天気を取得する','parameters':{'type':'object','properties':{'city':{'type':'string'},'date':{'type':'string'}},'required':['city','date'],'additionalProperties':False}}}],'tool_choice':'required'})]
    # A conflicting city request distinguishes schema enforcement from easy JSON prompting.
    json_schema_case=next(s for s in scenarios if s[0]=='json')
    scenarios.append(('json-enforcement','cityは大阪、activitiesは3つの文字列にして休日の活動をJSONだけで返してください。',256,json_schema_case[3]))
    selection=os.environ.get('ORNITH_SCENARIOS')
    if not selection or 'context' in selection:
        # Measure occupied prompt length, not merely allocated context capacity.
        for target in (4096,16384,32768):
            token_target='http://127.0.0.1:58009' if hipfire else url
            prefix='次は架空の資料です。最後の質問に答えてください。\n';unit='参考記録：水は透明です。日付は不明です。\n';tail='\n休日に家庭菜園を楽しむ方法を自然な日本語で詳しく説明してください。'
            lo,hi=0,target
            while lo+1<hi:
                mid=(lo+hi)//2;msg=[{'role':'user','content':prefix+unit*mid+tail}]
                prompt=api('/apply-template',{'messages':msg,'chat_template_kwargs':{'enable_thinking':False}},target=token_target)['prompt']
                n=len(api('/tokenize',{'content':prompt,'add_special':False},target=token_target)['tokens'])
                if n<=target: lo=mid
                else: hi=mid
            scenarios.append((f'context-{target}',prefix+unit*lo+tail,768,{}))
    if selection: scenarios=[s for s in scenarios if any(s[0].startswith(x) for x in selection.split(','))]
    (out/'scenarios.json').write_text(json.dumps(scenarios,ensure_ascii=False,indent=2))
    for name,prompt,limit,extra in scenarios:
        body={**standard,'messages':[{'role':'user','content':prompt}],'max_tokens':limit,**extra}
        try:
            warm_body={**body,'messages':[{'role':'user','content':'Reply with exactly OK.'}],'max_tokens':32} if different_warmup else body
            warm=stream(warm_body,name+'-warmup');rows.append(warm)
            for trial in range(1,iterations+1):
                row=stream(body,name+'-'+str(trial));rows.append(row)
                print(json.dumps(row,ensure_ascii=False),flush=True)
        except Exception as e:
            ensure()
            rows.append({'case':case,'scenario':name,'trial':'','status':'error','error':str(e)})
            print(name,str(e),file=sys.stderr,flush=True)
except Exception as e:
    rows.append({'case':case,'scenario':'safety-or-runtime','trial':'','status':'aborted','error':str(e)})
    print(str(e),file=sys.stderr)
finally:
    stop.set()
    if server:
        try: os.killpg(server.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid,signal.SIGKILL);server.wait()
    (out/'telemetry.json').write_text(json.dumps(telemetry,indent=2))
    keys=list(dict.fromkeys(k for row in rows for k in row))
    with (out/'results.csv').open('x',newline='') as f:
        w=csv.DictWriter(f,fieldnames=keys);w.writeheader();w.writerows(rows)
    print('Evidence:',out,flush=True)
if any(r['status']!='ok' for r in rows): sys.exit(2)
PY
