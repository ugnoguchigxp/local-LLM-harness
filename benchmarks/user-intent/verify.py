"""Fresh-process artifact inference, saved-logit equivalence and CPU timings."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def memory():
    wanted = ('Rss', 'Pss', 'Swap')
    return {key:int(line.split()[1]) for line in Path('/proc/self/smaps_rollup').read_text().splitlines()
            if (key:=line.split(':')[0]) in wanted}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model-root',required=True)
    p.add_argument('--encoder-root',required=True)
    p.add_argument('--predictions',required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--worker',action='store_true')
    a=p.parse_args()
    # Load the exact formatter/inference source saved with the trained revision.
    sys.path.insert(0,str(Path(a.model_root)/'source'))
    from intent import IntentModel, LABELS, external, sha256, write_json
    output=external(a.output)
    if output.exists():raise ValueError('verification output exists')
    if not a.worker:
        output.mkdir(parents=True)
        for i in range(3):
            subprocess.run([sys.executable,__file__,'--worker','--model-root',a.model_root,
                            '--encoder-root',a.encoder_root,'--predictions',a.predictions,
                            '--output',str(output/f'rep{i}.json')],check=True,
                           env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',OPENBLAS_NUM_THREADS='4',TOKENIZERS_PARALLELISM='false'))
        reports=[json.loads((output/f'rep{i}.json').read_text()) for i in range(3)]
        if any(r['prediction_hash']!=reports[0]['prediction_hash'] for r in reports):
            raise ValueError('prediction instability across fresh processes')
        write_json(output/'summary.json',dict(repetitions=reports,stable_predictions=True,
                   max_logit_error=max(r['max_logit_error'] for r in reports),
                   max_probability_error=max(r['max_probability_error'] for r in reports),
                   quality_counted_once=True,HTTP_tested=False,service_changed=False))
        print('verification',json.dumps(reports,ensure_ascii=False),flush=True)
        return
    import numpy as np
    start=time.perf_counter()
    model=IntentModel(a.model_root,a.encoder_root)
    if sha256(sys.modules['intent'].__file__)!=model.head['input_contract']['formatter_sha256']:
        raise ValueError('inference source does not match training formatter')
    rows=[json.loads(line) for line in Path(a.predictions).read_text().splitlines() if line.strip()]
    for _ in range(10):model.predict(rows[0]['text'],rows[0]['previous_agent'])
    load_ms=(time.perf_counter()-start)*1000
    timings=[]
    labels=[]
    max_logit=max_probability=0.
    for row in rows:
        start=time.perf_counter()
        answer=model.predict(row['text'],row['previous_agent'])
        timings.append((time.perf_counter()-start)*1000)
        delta=float(np.max(np.abs(np.array([answer['logits'][l] for l in LABELS])-np.array([row['logits'][l] for l in LABELS]))))
        prob_delta=float(np.max(np.abs(np.array([answer['probabilities'][l] for l in LABELS])-np.array([row['probabilities'][l] for l in LABELS]))))
        max_logit,max_probability=max(max_logit,delta),max(max_probability,prob_delta)
        if answer['label']!=row['prediction'] or delta>5e-5 or prob_delta>1e-5:
            raise ValueError('saved artifact inference mismatch: '+row['id'])
        labels.append(answer['label'])
    import hashlib
    result=dict(count=len(rows),load_and_warmup_ms=load_ms,p50_ms=float(np.percentile(timings,50)),
                p95_ms=float(np.percentile(timings,95)),max_logit_error=max_logit,
                max_probability_error=max_probability,prediction_hash=hashlib.sha256(json.dumps(labels).encode()).hexdigest(),
                memory_kib=memory(),encoder_session_count=1,
                timing_scope='tokenization + all encoder calls + character features if selected + head + score serialization; excludes HTTP',
                torch_imported='torch' in sys.modules,sklearn_imported='sklearn' in sys.modules)
    write_json(output,result)


if __name__=='__main__':main()
