"""Compare actual task logits: Torch FP32 saved output vs ONNX FP32 vs ONNX INT8."""
import argparse
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from common import LABELS, format_input, load_examples, require_external, sha256, write_json

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--sandbox',required=True)
    p.add_argument('--model',required=True)
    p.add_argument('--head',required=True)
    p.add_argument('--reference-run',required=True)
    p.add_argument('--output',required=True)
    a=p.parse_args()
    sandbox=require_external(a.sandbox)
    manifest=json.loads((sandbox/'artifacts'/(a.model+'-manifest.json')).read_text())
    head=json.loads(Path(a.head).read_text())
    rows={r['id']:r for r in load_examples()}
    reference=[]
    for f in Path(a.reference_run).glob('*-rep0.jsonl'):
        reference.extend(json.loads(line) for line in f.read_text().splitlines())
    tokenizer=Tokenizer.from_file(str(Path(manifest['path'])/'tokenizer.json'))
    tokenizer.enable_truncation(max_length=512,direction='left')
    options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
    sessions={precision:ort.InferenceSession(str(sandbox/'onnx'/(a.model+'-'+precision+'.onnx')),options,
                                           providers=['CPUExecutionProvider']) for precision in ['fp32','int8']}
    details=[]
    for ref in reference:
        text=manifest['input_prefix']+format_input(rows[ref['id']],ref['mode'])
        encoded=tokenizer.encode(text)
        feed={'input_ids':np.asarray([encoded.ids],dtype=np.int64),'attention_mask':np.asarray([encoded.attention_mask],dtype=np.int64)}
        cfg=head['modes'][ref['mode']]
        expected=np.asarray([ref['raw_scores'][l] for l in LABELS])
        original_prediction=LABELS[int(expected.argmax())]
        record={'id':ref['id'],'mode':ref['mode'],'split':ref['split'],'reference_prediction':original_prediction}
        vectors={}
        for precision,session in sessions.items():
            vector=session.run(None,feed)[0][0]
            vectors[precision]=vector
            scores=np.asarray(cfg['weights'],dtype=np.float32)@vector+np.asarray(cfg['bias'],dtype=np.float32)
            record[precision]={'scores':dict(zip(LABELS,scores.tolist())),
                               'prediction':LABELS[int(scores.argmax())],'max_logit_difference':float(np.abs(expected-scores).max())}
        record['embedding_cosine']=float(vectors['fp32']@vectors['int8']/(np.linalg.norm(vectors['fp32'])*np.linalg.norm(vectors['int8'])))
        details.append(record)
    summary={}
    for mode in 'ABC':
        sample=[r for r in details if r['mode']==mode and r['split']=='eval']
        summary[mode]={precision:{'max_logit_difference':max(r[precision]['max_logit_difference'] for r in sample),
                                  'prediction_changes':sum(r[precision]['prediction']!=r['reference_prediction'] for r in sample)}
                       for precision in sessions}
        summary[mode]['min_embedding_cosine']=min(r['embedding_cosine'] for r in sample)
    output=require_external(a.output)
    write_json(output,dict(model=a.model,revision=manifest['revision'],head_sha256=sha256(a.head),summary=summary,details=details))
    print(a.model,summary)
