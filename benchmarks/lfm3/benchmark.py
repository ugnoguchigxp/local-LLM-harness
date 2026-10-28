#!/usr/bin/env python3
"""Isolated LFM3 streaming benchmark. Writes measurements and visible answers outside the repo."""
import json, time, urllib.request, urllib.error, statistics, pathlib, argparse, hashlib

URL='http://127.0.0.1:18094'
SYSTEM='あなたは日本語の会話アシスタントです。ユーザーの指示と会話履歴を正確に守り、簡潔に答えてください。'
CASES=[
 ('conversation','久しぶりに会う友達が緊張しています。自然な日本語で一言声をかけてください。'),
 ('arithmetic','鉛筆は1本120円、消しゴムは1個80円。鉛筆3本と消しゴム2個を買い、1000円払います。お釣りは何円ですか？'),
 ('logic','赤、青、緑の箱が1つずつあります。鍵は赤にはなく、青か緑にあります。青は空です。鍵はどの箱にありますか？理由も短く。'),
]
HISTORY=[{'role':'system','content':SYSTEM},{'role':'user','content':'私は佐藤です。猫の名前はミント、好きな飲み物は麦茶です。'},{'role':'assistant','content':'佐藤さん、猫のミントと麦茶がお好きなのですね。'},{'role':'user','content':'訂正です。猫の名前はミントではなくコハクです。犬は飼っていません。'},{'role':'assistant','content':'了解しました。猫の名前はコハクで、犬はいないのですね。'},{'role':'user','content':'私は来週の水曜日に京都へ行きます。移動手段は新幹線です。'},{'role':'assistant','content':'来週水曜日に新幹線で京都へ行く予定ですね。'},{'role':'user','content':'確認です。私の名字、猫の名前、好きな飲み物、旅行先と移動手段をそれぞれ答えてください。'}]

def post(path,obj):
 req=urllib.request.Request(URL+path,data=json.dumps(obj,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=180) as r: return json.load(r)

def run(effort,messages):
 reqbody={'model':'lfm3','messages':messages,'reasoning_effort':effort,'stream':True,'stream_options':{'include_usage':True},'max_tokens':1024,'temperature':0.1,'top_k':50,'repeat_penalty':1.1,'seed':42,'cache_prompt':False,'timings_per_token':True}
 request=urllib.request.Request(URL+'/v1/chat/completions',data=json.dumps(reqbody,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
 start=time.monotonic(); first=None; visible=None; thought_chars=0; out=''; timings=None; usage=None; finish=None
 try:
  with urllib.request.urlopen(request,timeout=180) as response:
   for b in response:
    if not b.startswith(b'data: '): continue
    data=b[6:].strip()
    if data==b'[DONE]': break
    item=json.loads(data); now=time.monotonic(); choices=item.get('choices',[])
    if item.get('usage'):usage=item['usage']
    if item.get('timings'):timings=item['timings']
    if not choices:continue
    choice=choices[0];delta=choice.get('delta',{}); reason=delta.get('reasoning_content') or ''; content=delta.get('content') or ''
    if (reason or content) and first is None:first=now-start
    if content and visible is None:visible=now-start
    thought_chars+=len(reason);out+=content
    if choice.get('finish_reason'):finish=choice['finish_reason']
  return {'effort':effort,'first_token_s':first,'first_visible_s':visible,'total_s':time.monotonic()-start,'reasoning_chars':thought_chars,'visible_answer':out,'finish_reason':finish,'usage':usage,'timings':timings}
 except Exception as e:return {'effort':effort,'error':str(e),'total_s':time.monotonic()-start}

def main():
 p=argparse.ArgumentParser();p.add_argument('output');a=p.parse_args(); out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
 modes=['none','low','medium','high','max'];records=[]
 for mode in modes:
  try:
   t=post('/apply-template',{'messages':[{'role':'user','content':'こんにちは'}],'reasoning_effort':mode}); print('template',mode,hashlib.sha256(json.dumps(t,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:16],flush=True)
  except Exception as e:print('template error',mode,str(e),flush=True)
 warmup=run('none',[{'role':'user','content':'こんにちは。短く挨拶して。'}]); print('warmup',warmup.get('finish_reason'),flush=True)
 for index,(case,prompt) in enumerate(CASES):
  for mode in modes:
   result=run(mode,[{'role':'system','content':SYSTEM},{'role':'user','content':prompt}]);result['case']=case;records.append(result);(out/'results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));print(case,mode,json.dumps({k:v for k,v in result.items() if k not in ('visible_answer','timings')},ensure_ascii=False),flush=True)
 for mode in ['none','high']:
  result=run(mode,HISTORY);result['case']='context-correction'; records.append(result);(out/'results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)); print('context',mode,json.dumps({k:v for k,v in result.items() if k not in ('visible_answer','timings')},ensure_ascii=False),flush=True)
 filler='記録：会話の主題は旅行の準備です。会話履歴の参考情報です。\n'*420
 long_messages=[{'role':'system','content':SYSTEM},{'role':'user','content':'重要メモ：本人の名前は楓、猫の名前はコハク、暗証語は七色の灯台です。以下は関連しない記録です。\n'+filler+'\n重要メモに書かれた本人と猫の名前、暗証語を答えてください。'}]
 for mode in ['none','high']:
  result=run(mode,long_messages);result['case']='long-context-recall';records.append(result);(out/'results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));print('long-context',mode,json.dumps({k:v for k,v in result.items() if k not in ('visible_answer','timings')},ensure_ascii=False),flush=True)
 # Extended near-32K recall and real multi-turn conversations.
 filler='記録：会話の主題は旅行の準備です。会話履歴の参考情報です。\n'*1500
 long_messages=[{'role':'system','content':SYSTEM},{'role':'user','content':'重要メモ：本人の名前は楓、猫の名前はコハク、暗証語は七色の灯台です。以下は関連しない記録です。\n'+filler+'\n重要メモに書かれた本人と猫の名前、暗証語を答えてください。'}]
 for mode in ['none','high']:
  result=run(mode,long_messages);result['case']='near-32k-recall';records.append(result)
  (out/'results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
  print('near-32k',mode,json.dumps({k:v for k,v in result.items() if k not in ('visible_answer','timings')},ensure_ascii=False),flush=True)
 prompts=['私は高橋です。猫の名前はミントで、好きな飲み物は麦茶です。短く返事をしてください。','訂正します。猫の名前はミントではなくコハクです。犬はいません。短く返事してください。','来週水曜日に京都へ新幹線で行きます。簡潔に返事してください。','確認です。私の名字、猫の名前、好きな飲み物、旅行先、移動手段をそれぞれ答えてください。']
 for mode in ['none','high']:
  messages=[{'role':'system','content':SYSTEM}]
  for number,prompt in enumerate(prompts,1):
   messages.append({'role':'user','content':prompt});result=run(mode,messages);result['case']=f'live-conversation-{number}';records.append(result)
   (out/'results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
   if result.get('finish_reason')!='stop' or not result.get('visible_answer'):raise RuntimeError('conversation turn failed')
   messages.append({'role':'assistant','content':result['visible_answer']})
   print('live-conversation',mode,number,flush=True)
 print('completed',len(records),flush=True)
if __name__=='__main__':main()
