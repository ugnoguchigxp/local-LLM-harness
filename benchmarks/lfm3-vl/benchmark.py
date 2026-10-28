#!/usr/bin/env python3
"""Local-only, synthetic LFM3-VL evaluation. Output and generated images stay outside Git."""
import base64, json, os, subprocess, threading, time, urllib.request, urllib.error
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT=Path(os.environ.get('LFM_VL_OUT','/srv/ai/evidence/lfm3-vl-20261028'))
MODEL=Path('/srv/ai/models/lfm3-vl-2b-gguf')
SERVER='/srv/ai/apps/llama-lfm3-vl-20261028/build-vulkan/bin/llama-server'
OUT.mkdir(parents=True,exist_ok=True)
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',30)
for name,lines in {
 'ui':['設定画面','ネットワーク　接続済み','保存　キャンセル','音量　75%'],
 'error':['端末  ~/project','$ npm run build','Error: Cannot find module config.json','ビルドに失敗しました'],
 'activity1':['ファイル編集','報告書.txt','売上報告を作成中','保存前'],
 'activity2':['ファイル編集','報告書.txt','売上報告を作成中','保存しました']}.items():
 im=Image.new('RGB',(1000,400),'white'); d=ImageDraw.Draw(im)
 for i,line in enumerate(lines): d.text((30,25+i*80),line,font=font,fill='black')
 im.save(OUT/(name+'.png'))
def part(path):
 return {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(Path(path).read_bytes()).decode()}}
fix=Path('/srv/ai/evidence/visual-recognition-20261018/fixtures')
cases=[('overview',[OUT/'ui.png'],'画面全体を簡潔に説明してください。'),('ui',[OUT/'ui.png'],'ネットワークの状態と音量は何ですか？'),('error',[OUT/'error.png'],'何が起き、どのファイルが見つからないですか？'),('ocr',[fix/'table-ja.png'],'表の内容を行ごとに正確に書き出してください。'),('activity',[OUT/'activity2.png'],'今何をしているように見えますか？直接確認できることと推測を分けてください。'),('sequence',[OUT/'activity1.png',OUT/'activity2.png'],'1枚目から2枚目に何が変化しましたか？')]
def run_request(name,paths,prompt,thinking):
 body={'model':'lfm3-vl','messages':[{'role':'user','content':[*(part(p) for p in paths),{'type':'text','text':prompt}]}], 'temperature':0.1,'top_p':1.0,'top_k':50,'min_p':0.0,'repeat_penalty':1.1,'max_tokens':512,'seed':42,'stream':True,'cache_prompt':False,'chat_template_kwargs':{'enable_thinking':thinking}}
 req=urllib.request.Request('http://127.0.0.1:18096/v1/chat/completions',json.dumps(body).encode(),{'Content-Type':'application/json'})
 start=time.monotonic(); first=None; content=''; reasoning=''; timings=None; finish=None
 try:
  with urllib.request.urlopen(req,timeout=180) as res:
   for line in res:
    if not line.startswith(b'data: '): continue
    data=line[6:].strip()
    if data==b'[DONE]': break
    obj=json.loads(data); timings=obj.get('timings',timings)
    for choice in obj.get('choices',[]):
     delta=choice.get('delta',{}); a=delta.get('content') or ''; b=delta.get('reasoning_content') or ''
     if (a or b) and first is None: first=time.monotonic()-start
     content+=a; reasoning+=b; finish=choice.get('finish_reason') or finish
  return {'case':name,'images':[str(p) for p in paths],'sizes':[Image.open(p).size for p in paths],'prompt':prompt,'thinking':thinking,'first_s':first,'total_s':time.monotonic()-start,'content':content,'reasoning':reasoning,'timings':timings,'finish':finish}
 except Exception as e: return {'case':name,'thinking':thinking,'error':str(e),'total_s':time.monotonic()-start}
def measure(quant):
 model=MODEL/('LFM3-VL-2B-'+quant+'.gguf'); log=open(OUT/(quant+'.log'),'w')
 cmd=[SERVER,'-m',str(model),'--mmproj',str(MODEL/'mmproj-LFM3-VL-2B-F16.gguf'),'--alias','lfm3-vl','-dev','Vulkan0','-ngl','999','--fit','off','--ctx-size','8192','--parallel','1','--batch-size','512','--ubatch-size','256','--threads','8','--host','127.0.0.1','--port','18096','--jinja','--reasoning-format','deepseek','--no-cache-prompt','--no-webui']
 t=time.monotonic(); p=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT); ready=None
 try:
  for _ in range(600):
   if p.poll() is not None: raise RuntimeError('server exited '+str(p.returncode))
   try:
    with urllib.request.urlopen('http://127.0.0.1:18096/health',timeout=1) as r:
     if r.status==200: ready=time.monotonic()-t; break
   except Exception: pass
   time.sleep(.25)
  if ready is None: raise RuntimeError('startup timeout')
  def mem():
   s=Path('/proc/%d/status'%p.pid).read_text(); return {x.split(':')[0]:x.split(':')[1].strip() for x in s.splitlines() if x.startswith(('VmRSS:','VmHWM:','VmSwap:'))}
  idle=mem(); rows=[]; samples=[]; sampling=True
  def sample():
   while sampling:
    try:
     ps=subprocess.check_output(['ps','-p',str(p.pid),'-o','%cpu=,rss='],text=True).strip()
     gpu=Path('/sys/class/drm/card1/device/gpu_busy_percent').read_text().strip()
     samples.append({'t':time.monotonic()-t,'ps':ps,'gpu_percent':gpu})
    except (OSError,subprocess.CalledProcessError): pass
    time.sleep(1)
  monitor=threading.Thread(target=sample,daemon=True); monitor.start()
  todo=[cases[0],cases[0],cases[0],*cases[1:],cases[1]]
  if quant=='QAD-Q4_0': todo += [cases[1]]
  for i,case in enumerate(todo):
   thinking=quant=='QAD-Q4_0' and i==len(todo)-1
   row=run_request(*case,thinking); row['order']=i; row['process_memory_after']=mem(); rows.append(row)
   (OUT/(quant+'.json')).write_text(json.dumps({'command':cmd,'ready_s':ready,'idle':idle,'samples':samples,'results':rows},ensure_ascii=False,indent=2))
   print(quant,i,row['case'],row.get('first_s'),row.get('total_s'),row.get('finish'),row.get('error'),flush=True)
 finally:
  sampling=False
  p.terminate()
  try: p.wait(timeout=15)
  except subprocess.TimeoutExpired: p.kill(); p.wait()
  log.close()
for q in ('QAD-Q4_0','Q8_0'): measure(q)
