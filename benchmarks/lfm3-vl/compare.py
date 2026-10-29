#!/usr/bin/env python3
"""Compare local YOLO/OCR and LFM3-VL on shared, non-private fixtures."""
import base64, hashlib, json, os, subprocess, sys, time, urllib.request
from pathlib import Path
from PIL import Image
ROOT=Path(os.environ.get('LFM_VL_OUT','/srv/ai/evidence/lfm3-vl-followup-20261028'));ROOT.mkdir(parents=True,exist_ok=True)
release=Path('/opt/larm-local-services/releases/vision-ocr-host/7e97dbc683e120e5dbcea7382749bf4f5c4cfd2575f496f6db304baff4695811')
fixtures=Path('/srv/ai/evidence/visual-recognition-20261018/fixtures')
photo=Path('/srv/ai/evidence/wevisone-vl-trial-20261025/images')
images={'desk':photo/'desk-spill.png','repair':photo/'repair-workbench.png','bus':fixtures/'bus.png','car':fixtures/'car.png','table':fixtures/'table-ja.png','text':fixtures/'japanese-text.png','blank':fixtures/'blank.png','screen':Path('/srv/ai/evidence/lfm3-omni-20261028/screen.png'),'error':Path('/srv/ai/evidence/lfm3-vl-20261028/error.png')}
cases=[('desk_scene','desk','画像で直接確認できることと推測を分け、今何が起きているか日本語で簡潔に説明してください。'),('desk_count','desk','カップは何個ありますか。それぞれの色と状態を説明してください。'),('desk_absent','desk','犬は写っていますか。確認できなければ、いないと答えてください。'),('desk_location','desk','スマートフォンは画像のどの位置にありますか。'),('repair_activity','repair','左と右の人物について、画像で直接確認できることと推測を分けて何をしているか説明してください。'),('repair_ocr','repair','画像内で読める文字をそのまま書き出してください。'),('repair_count','repair','手前のテーブル上に置かれたドライバーは何本ですか。それぞれの色も答えてください。'),('bus_objects','bus','画像に見える主な物体と、おおよその位置を説明してください。'),('car_objects','car','画像に見える主な物体と、おおよその位置を説明してください。'),('table_ocr','table','表の内容をすべて正確に書き出してください。'),('text_ocr','text','画像内の文字を正確にすべて書き出してください。'),('blank','blank','画像内に文字や物体がありますか。確認できることだけ答えてください。'),('screen_ui','screen','画面の右上には何がありますか。音声認識の状態と未処理件数も答えてください。'),('screen_absent','screen','削除ボタンは見えますか。'),('error','error','何が起き、どのファイルが見つからないですか。')]
if os.environ.get('LFM_VL_STRESS') == '1':
 stress=Path('/srv/ai/evidence/visual-recognition-integration-20261018/additional-corpus')
 images={k:stress/(k+'.png') for k in ('low-contrast-table','blurred-table','skewed-table','document-mixed-ja')}
 cases=[(k,k,'画像の表に書かれている文字と数値を行ごとに正確に書き出してください。') for k in images]
metadata={k:{'path':str(p),'size':Image.open(p).size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for k,p in images.items()}
sys.path[:0]=[str(release),str(release/'site-packages')]
from vision_ocr.engines import ObjectEngine,OcrEngine,load_image
config={'models':json.loads((release/'models/models.json').read_text())}; baseline={}
for kind,cls in [('objects',ObjectEngine),('ocr',OcrEngine)]:
 engine=cls(config); rows=[]
 for key,path in images.items():
  img=load_image(path)
  for rep in range(2):
   t=time.monotonic(); result=engine.infer(img); rows.append({'image':key,'repeat':rep,'elapsed_s':time.monotonic()-t,'result':result})
 baseline[kind]=rows
(ROOT/'baseline.json').write_text(json.dumps({'metadata':metadata,'runs':baseline},ensure_ascii=False,indent=2))
server=['/srv/ai/apps/llama-lfm3-vl-20261028/build-vulkan/bin/llama-server','-m','/srv/ai/models/lfm3-vl-2b-gguf/LFM3-VL-2B-QAD-Q4_0.gguf','--mmproj','/srv/ai/models/lfm3-vl-2b-gguf/mmproj-LFM3-VL-2B-F16.gguf','--alias','lfm3-vl','-dev','Vulkan0','-ngl','999','--fit','off','-c','8192','-np','1','-b','512','-ub','256','-t','8','--host','127.0.0.1','--port','18096','--jinja','--no-cache-prompt','--no-webui']
log=(ROOT/'server.log').open('w');p=subprocess.Popen(server,stdout=log,stderr=subprocess.STDOUT)
try:
 for _ in range(240):
  if p.poll() is not None: raise RuntimeError('server stopped')
  try:
   if urllib.request.urlopen('http://127.0.0.1:18096/health',timeout=1).status==200:break
  except Exception: time.sleep(.25)
 else: raise RuntimeError('startup timeout')
 rows=[]
 for name,key,prompt in cases:
  url='data:image/'+('jpeg' if images[key].suffix.lower() in ('.jpg','.jpeg') else 'png')+';base64,'+base64.b64encode(images[key].read_bytes()).decode()
  body={'model':'lfm3-vl','messages':[{'role':'user','content':[{'type':'image_url','image_url':{'url':url}},{'type':'text','text':prompt}]}],'temperature':0.1,'top_p':1,'top_k':50,'min_p':0,'repeat_penalty':1.1,'max_tokens':512,'seed':42,'cache_prompt':False,'chat_template_kwargs':{'enable_thinking':False}}
  for rep in range(2):
   t=time.monotonic(); req=urllib.request.Request('http://127.0.0.1:18096/v1/chat/completions',json.dumps(body).encode(),{'Content-Type':'application/json'})
   try:
    with urllib.request.urlopen(req,timeout=120) as r: data=json.load(r)
    row={'case':name,'image':key,'prompt':prompt,'repeat':rep,'elapsed_s':time.monotonic()-t,'answer':data['choices'][0]['message']['content'],'finish':data['choices'][0]['finish_reason'],'timings':data.get('timings')}
   except Exception as e: row={'case':name,'repeat':rep,'error':str(e)}
   rows.append(row); (ROOT/'lfm.json').write_text(json.dumps({'metadata':metadata,'command':server,'results':rows},ensure_ascii=False,indent=2)); print(name,rep,row.get('elapsed_s'),row.get('finish'),row.get('error'),flush=True)
finally:
 p.terminate();p.wait(timeout=15);log.close()
