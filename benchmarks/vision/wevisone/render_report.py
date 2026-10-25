"""Build an offline result explorer; no external scripts or network requests."""
import argparse
import json
from pathlib import Path


TEMPLATE = '''<!doctype html>
<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeVisOne 視覚理解試験</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#172435;font:15px system-ui,"Noto Sans CJK JP",sans-serif}
header{background:#14293d;color:white;padding:24px 32px}header h1{margin:0 0 8px;font-size:25px}header p{margin:0;color:#cbdaea}
main{display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px;padding:20px;max-width:1700px;margin:auto}
nav,article{background:white;border:1px solid #dce3ea;border-radius:12px;padding:16px}nav{align-self:start}
button{font:inherit;cursor:pointer;border:1px solid #dce3ea;border-radius:7px;padding:9px 12px;background:white;color:inherit}
nav button{display:block;text-align:left;width:100%;margin:4px 0;font-size:13px}button.selected{background:#dcefff;border-color:#2785bf}
.toolbar{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:14px 0}.stage{position:relative;background:#eee}.stage img{display:block;width:100%;height:auto}
.stage svg{position:absolute;inset:0;width:100%;height:100%}svg rect{fill:none;stroke:#ff3d72;stroke-width:4}svg rect.focus{stroke:#00ffd5;stroke-width:7}
svg text{fill:#fff;paint-order:stroke;stroke:#172435;stroke-width:4px;stroke-linejoin:round;font-size:23px}
h2{font-size:21px;margin:0 0 10px}h3{margin:18px 0 8px}p{line-height:1.7}.muted{color:#617083}.metric{background:#eff5fa;padding:10px;border-radius:6px}
pre{background:#112338;color:#e6f1fc;padding:16px;border-radius:8px;white-space:pre-wrap;word-break:break-word;line-height:1.6;font-size:13px}
.annotations{display:flex;gap:6px;flex-wrap:wrap}.annotations button{font-size:12px}a{color:#126da0}
@media(max-width:850px){main{display:block;padding:10px}nav{margin-bottom:12px;max-height:240px;overflow:auto}header{padding:20px}}
</style>
<header><h1>WeVisOne：画像の意味と対象の特定</h1><p>生成画像と色を入れ替えた画像による探索試験。項目を選ぶと、実際の応答と検出位置を確認できます。</p></header>
<main><nav id="cases"></nav><article><h2 id="title"></h2><p id="query"></p><p class="metric" id="metrics"></p>
<div class="toolbar"><label><input type="checkbox" id="boxes" checked>検出位置</label><label><input type="checkbox" id="labels" checked>名称</label><label><input type="checkbox" id="mask">公式のマスク画像</label><a id="json">結果JSON</a><a id="original">元画像</a></div>
<p id="maskwarning" style="color:#9e2940"></p><div class="stage"><img id="image" alt="試験画像"><svg id="overlay"></svg></div><div class="annotations" id="annotations"></div>
<h3>モデルの応答</h3><pre id="response"></pre><h3>評価上の注意</h3><p id="review"></p>
<h3>現行YOLO・OCRの同じ画像に対する結果</h3><pre id="baseline"></pre>
</article></main><script>
const DATA=__DATA__;let active=0,focus=-1;const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
function draw(){const r=DATA.cases[active],w=r.image_size?.[0]||1536,h=r.image_size?.[1]||1024,o=$('overlay');o.replaceChildren();o.setAttribute('viewBox',`0 0 ${w} ${h}`);
 $('image').src=$('mask').checked&&r.artifacts?.overlay?(r.artifacts.binary_overlay||r.artifacts.overlay):'images/'+r.case.image;
 if(!$('boxes').checked||$('mask').checked)return;let i=0;for(const [label,items]of Object.entries(r.predictions||{}))for(const item of items){if(item.type!=='box')continue;
 const [x1,y1,x2,y2]=item.coords;const rect=document.createElementNS(NS,'rect');for(const[k,v]of Object.entries({x:x1,y:y1,width:x2-x1,height:y2-y1}))rect.setAttribute(k,v);if(i===focus)rect.classList.add('focus');o.append(rect);
 if($('labels').checked){const t=document.createElementNS(NS,'text');t.setAttribute('x',Math.max(4,x1));t.setAttribute('y',Math.max(26,y1-8));t.textContent=label;o.append(t)}i++}}
function show(index){active=index;focus=-1;const r=DATA.cases[index];$('title').textContent=r.case.id+' · '+r.case.task+(r.run?' · '+r.run:'');$('query').textContent=Array.isArray(r.case.query)?r.case.query.join(' / '):r.case.query;
 $('metrics').textContent=`推論 ${r.predict_seconds?.toFixed(2)||'—'} 秒 ／ 後処理・保存 ${(r.postprocess_parse_and_export_seconds??r.export_seconds)?.toFixed(2)||'—'} 秒 ／ 出力 ${r.measurements?.generation?.output_tokens??'—'} token ／ GPUピーク ${((r.cuda_peak_allocated_bytes||0)/2**30).toFixed(2)} GiB`;
 $('maskwarning').textContent=r.mask_warning||'';
 $('response').textContent=r.response||r.traceback||'';$('review').textContent=(r.mask_warning||'')+(r.case.review||('期待対象は生成後の画像を目視で確認したものです。近似IoU: '+JSON.stringify(r.approximate_target_max_iou??null)+'。少数の画像による探索結果を一般的な精度とみなすことはできません。'));
 $('json').href=r.artifacts?.metadata||'#';$('original').href='images/'+r.case.image;$('mask').checked=false;$('mask').disabled=!r.mask_count;
 const b=(DATA.baseline?.cases||[]).filter(x=>x.image===r.case.image);$('baseline').textContent=JSON.stringify(b,null,2);
 $('annotations').replaceChildren();let i=0;for(const[label,items]of Object.entries(r.predictions||{}))for(const item of items){if(item.type!=='box')continue;const n=i++,button=document.createElement('button');button.textContent=label;button.onclick=()=>{focus=n;draw()};$('annotations').append(button)}
 [...$('cases').children].forEach((b,i)=>b.classList.toggle('selected',i===index));draw()}
DATA.cases.forEach((r,i)=>{const b=document.createElement('button');b.textContent=r.case.id+(r.backbone_dtype==='torch.bfloat16'?' · BF16':'')+(r.run==='timing-detail'?' · 詳細':'');b.onclick=()=>show(i);$('cases').append(b)});
for(const id of ['boxes','labels','mask'])$(id).onchange=draw;if(DATA.cases.length){const h=decodeURIComponent(location.hash.slice(1));show(Math.max(0,DATA.cases.findIndex(r=>r.case.id===h||r.case.id+'@'+r.run===h)));if(new URLSearchParams(location.search).has('mask')&&!$('mask').disabled){$('mask').checked=true;draw()}}
</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--runs", nargs="+", default=["trial.json", "counterfactual.json", "timing-detail.json", "dense-bfloat16.json", "bfloat16-followup.json"])
    args = parser.parse_args()
    if args.evidence.resolve().is_relative_to(Path(__file__).resolve().parents[3]):
        raise ValueError("generated report must stay outside the source repository")
    runs = [json.loads((args.evidence / name).read_text()) for name in args.runs
            if (args.evidence / name).is_file()]
    data = {**runs[0], "cases": [row for run in runs for row in run["cases"]]}
    from PIL import Image
    for row in data["cases"]:
        if row.get("mask_count") and row.get("artifacts", {}).get("alpha"):
            with Image.open(args.evidence / row["artifacts"]["alpha"]) as alpha:
                if alpha.getextrema()[1] == 0:
                    row["mask_warning"] = "注意：保存されたマスクは全画素0で、領域抽出の成功を確認できていません。座標取得と分けて評価してください。 "
    baseline = args.evidence / "baseline.json"
    if baseline.is_file():
        data["baseline"] = json.loads(baseline.read_text())
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    (args.evidence / "index.html").write_text(TEMPLATE.replace("__DATA__", payload))
    print(args.evidence / "index.html")


if __name__ == "__main__":
    main()
