"""Replay saved six-way scores without model calls. Quality counts repetition zero only."""
import argparse
import csv
import itertools
import json
import math
from pathlib import Path
from common import LABELS, require_external, write_json


def percentile(values, q):
    if not values: return None
    values = sorted(values)
    i = (len(values)-1)*q
    lo, hi = int(i), min(int(i)+1,len(values)-1)
    return values[lo] + (values[hi]-values[lo])*(i-lo)


def rate(numerator, denominator):
    return {'count': numerator, 'denominator': denominator, 'rate': numerator/denominator if denominator else None}


def replay(rows, margin=0., hysteresis=0., alpha=1.):
    if margin < 0 or hysteresis < 0 or not 0 < alpha <= 1:
        raise ValueError('invalid replay parameters')
    predictions = []
    last_conversation = None
    current, smooth = None, None
    for row in sorted(rows,key=lambda r:(r['conversation_id'],r['chunk_order'])):
        if row['conversation_id'] != last_conversation:
            current, smooth = None, None
        if set(row['decision_scores']) != set(LABELS):
            raise ValueError('all six candidate scores are required')
        scores = [row['decision_scores'][l] for l in LABELS]
        if not all(math.isfinite(s) for s in scores):
            raise ValueError('non-finite candidate score')
        smooth = scores if smooth is None else [alpha*v+(1-alpha)*old for v,old in zip(scores,smooth)]
        top = max(range(6),key=lambda k:smooth[k])
        second = sorted(smooth,reverse=True)[1]
        proposed = 0 if smooth[top]-second < margin else top
        # The neutral fallback is also subject to hysteresis; no ground truth enters this policy.
        if current is not None and proposed != current and smooth[proposed]-smooth[current] < hysteresis:
            proposed = current
        predictions.append((row,LABELS[proposed]))
        current, last_conversation = proposed, row['conversation_id']
    return predictions


def metrics(predictions):
    matrix = [[0]*6 for _ in LABELS]
    incorrect = suppressed = tech_wrong = 0
    expressive_n = tech_n = 0
    conversations = {}
    errors=[]
    for row, predicted in predictions:
        matrix[LABELS.index(row['primary_label'])][LABELS.index(predicted)] += 1
        outside = predicted not in row['acceptable_labels']
        incorrect += outside
        expressive = row['primary_label'] != 'none' and 'none' not in row['acceptable_labels']
        expressive_n += expressive
        suppressed += expressive and predicted == 'none'
        technical = 'technical' in row['tags'] and row['primary_label'] == 'none'
        tech_n += technical
        tech_wrong += technical and predicted != 'none'
        conversations.setdefault(row['conversation_id'],[]).append((row,predicted))
        if outside:
            errors.append({'id':row['id'],'expected':row['primary_label'],'acceptable':row['acceptable_labels'],
                           'predicted':predicted,'target':row['current_chunk']})
    per_class = {}
    for i,label in enumerate(LABELS):
        tp=matrix[i][i]
        support=sum(matrix[i])
        predicted_n=sum(r[i] for r in matrix)
        precision=tp/predicted_n if predicted_n else 0.
        recall=tp/support if support else 0.
        f1=2*precision*recall/(precision+recall) if precision+recall else 0.
        per_class[label]=dict(precision=precision,recall=recall,f1=f1,support=support)
    hold_n=unnecessary=change_n=late=unresolved=0
    completed_delays=[]
    changes=[]
    for seq in conversations.values():
        for i,(row,predicted) in enumerate(seq):
            if i and row['expression_transition']=='hold':
                hold_n += 1
                unnecessary += predicted != seq[i-1][1]
            if row['expression_transition']!='change': continue
            change_n += 1
            if predicted in row['acceptable_labels']:
                completed_delays.append(0)
                changes.append({'id':row['id'],'delay_chunks':0,'censored':False})
                continue
            late += 1
            delay=None
            # This is a retrospective metric only; replay above never looks at future scores.
            for j in range(i+1,len(seq)):
                if seq[j][0]['expression_transition']=='change': break
                if seq[j][1] in seq[j][0]['acceptable_labels']:
                    delay=j-i
                    break
            if delay is None: unresolved+=1
            else: completed_delays.append(delay)
            changes.append({'id':row['id'],'delay_chunks':delay,'censored':delay is None})
    n=len(predictions)
    return dict(n=n,agreement=sum(matrix[i][i] for i in range(6))/n if n else None,
                macro_f1=sum(v['f1'] for v in per_class.values())/6,
                confusion_matrix={'rows':'primary truth','columns':'prediction','labels':LABELS,'counts':matrix},
                per_class=per_class,unacceptable=rate(incorrect,n),
                expressive_to_none=rate(suppressed,expressive_n),technical_wrong_emotion=rate(tech_wrong,tech_n),
                unnecessary_switch=rate(unnecessary,hold_n),necessary_change_late=rate(late,change_n),
                unresolved_change=rate(unresolved,change_n),completed_change_delay_chunks=completed_delays,
                changes=changes,errors=errors)


def select_policy(calibration):
    if not calibration:
        raise ValueError('calibration partition is required for policy selection')
    best = None
    for margin,hysteresis,alpha in itertools.product([0.,.2,.6,1.2],[0.,.2,.6],[1.,.75,.5]):
        quality=metrics(replay(calibration,margin,hysteresis,alpha))
        # Preregistered objective; penalties are inactive when calibration has no transitions.
        objective=(quality['macro_f1'] - .1*(quality['unnecessary_switch']['rate'] or 0)
                   - .1*(quality['necessary_change_late']['rate'] or 0))
        tie=(objective,-margin,-hysteresis,alpha)
        if best is None or tie>best[0]:
            best=(tie,dict(margin=margin,hysteresis=hysteresis,alpha=alpha),quality)
    return {'parameters':best[1], 'calibration_metrics':best[2],
            'selection_split':'calibration only', 'objective':'macro_f1 - 0.1*unnecessary_switch - 0.1*necessary_change_late',
            'warning':'synthetic calibration; temporal policy selection needs separately annotated multi-chunk calibration conversations'}


def summarize(run_dirs, output, policy=None):
    groups={}
    metas={}
    for directory in run_dirs:
        for path in sorted(Path(directory).glob('*-rep*.jsonl')):
            metadata=json.loads(path.with_suffix('.meta.json').read_text())
            for line in path.read_text().splitlines():
                row=json.loads(line)
                key=(row['variant'],row['mode'])
                groups.setdefault(key,[]).append(row)
                metas.setdefault(key,{})[row['repetition']]=metadata
    report=[]
    for (variant,mode),rows in sorted(groups.items()):
        if {r['repetition'] for r in rows} != {0,1,2}:
            raise ValueError('exactly three repetitions are required')
        representative=[r for r in rows if r['repetition']==0]
        if len({r['id'] for r in representative})!=len(representative):
            raise ValueError('duplicate representative examples; do not combine duplicate run variants')
        signatures={r['id']:(r['primary_label'],r['split'],r['input_sha256']) for r in representative}
        for rep in range(3):
            batch=[r for r in rows if r['repetition']==rep]
            if len(batch)!=len(representative) or {r['id']:(r['primary_label'],r['split'],r['input_sha256']) for r in batch}!=signatures:
                raise ValueError('three complete comparable repetitions are required')
        eval_rows=[r for r in representative if r['split']=='eval']
        calibration=[r for r in representative if r['split']=='calibration']
        eval_times=[r for r in rows if r['split']=='eval']
        selected=select_policy(calibration)
        selected_quality=metrics(replay(eval_rows,**selected['parameters']))
        raw=metrics(replay(eval_rows))
        chosen=metrics(replay(eval_rows,**policy)) if policy else None
        meta=list(metas[(variant,mode)].values())
        for field in ['revision','repository','runtime','precision','device','execution_providers','threads',
                      'max_tokens','labels','criteria','instruction','head_sha256','onnx_sha256','protocol_sha256']:
            if len({json.dumps(m.get(field),sort_keys=True) for m in meta}) != 1:
                raise ValueError('experiment identity changed between repetitions: ' + field)
        hashes={m['data_sha256'] for m in meta}
        if len(hashes)!=1: raise ValueError('data identity differs')
        raw_preds={r['id']:max(LABELS,key=lambda l:r['decision_scores'][l]) for r in eval_rows}
        instability=len({r['id'] for r in eval_times if max(LABELS,key=lambda l:r['decision_scores'][l])!=raw_preds[r['id']]})
        score_delta=max(abs(r['raw_scores'][l]-next(x for x in eval_rows if x['id']==r['id'])['raw_scores'][l])
                        for r in eval_times for l in LABELS)
        memory_peak={k:max(m['memory_peak_observed_kib'][k] for m in meta) for k in meta[0]['memory_peak_observed_kib']}
        item=dict(variant=variant,mode=mode,preliminary=True,quality=raw,
                  selected_policy=selected,selected_policy_eval=selected_quality,requested_policy=policy,requested_policy_eval=chosen,
                  performance=dict(p50_ms=percentile([r['inference_ms'] for r in eval_times],.5),
                                   p95_ms=percentile([r['inference_ms'] for r in eval_times],.95),
                                   load_ms=[m['load_ms'] for m in meta],
                                   candidate_cache_ms=[m['candidate_cache_ms'] for m in meta],
                                   repetitions=3,timing_samples=len(eval_times),independent_quality_examples=len(eval_rows),
                                   cpu_ms=sum(r['cpu_ms'] for r in eval_times),
                                   cpu_core_equivalents=sum(r['cpu_ms'] for r in eval_times)/sum(r['inference_ms'] for r in eval_times),
                                   memory_peak_observed_kib=memory_peak,
                                   memory_baseline_kib=[m['memory_baseline_kib'] for m in meta],
                                   memory_loaded_kib=[m['memory_loaded_kib'] for m in meta],
                                   max_tokens_observed=max(r['token_count'] for r in eval_times),
                                   truncated_examples=len({r['id'] for r in eval_times if r['truncated']}),
                                   tts_start_delay_ms=None),
                  unstable_examples=instability,max_repetition_score_delta=score_delta,
                  revision=meta[0]['revision'],runtime=meta[0]['runtime'],data_sha256=next(iter(hashes)))
        report.append(item)
    if len({item['data_sha256'] for item in report})>1:
        raise ValueError('models evaluated different datasets')
    write_json(output/'summary.json',report)
    fields=['variant','mode','n','agreement','macro_f1','unacceptable','expressive_to_none','technical_wrong_emotion',
            'unnecessary_switch','necessary_change_late','p50_ms','p95_ms','rss_mib','pss_mib','swap_mib','cpu_core_equivalents']
    with (output/'summary.csv').open('w') as f:
        writer=csv.DictWriter(f,fieldnames=fields)
        writer.writeheader()
        for item in report:
            q,p=item['quality'],item['performance']
            row={k:item[k] for k in ['variant','mode']}
            row.update({k:q[k] for k in ['n','agreement','macro_f1']})
            row.update({k:q[k]['rate'] for k in fields[5:10]})
            row.update({k:p[k] for k in ['p50_ms','p95_ms','cpu_core_equivalents']})
            row.update(rss_mib=p['memory_peak_observed_kib']['Rss']/1024,pss_mib=p['memory_peak_observed_kib']['Pss']/1024,
                       swap_mib=p['memory_peak_observed_kib']['Swap']/1024)
            writer.writerow(row)
    return report


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--runs',nargs='+',required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--margin',type=float,default=0)
    p.add_argument('--hysteresis',type=float,default=0)
    p.add_argument('--alpha',type=float,default=1)
    a=p.parse_args()
    output=require_external(a.output)
    output.mkdir(parents=True,exist_ok=True)
    results=summarize(a.runs,output,dict(margin=a.margin,hysteresis=a.hysteresis,alpha=a.alpha))
    for r in results:
        q,t=r['quality'],r['performance']
        print(r['variant'],r['mode'],f"n={q['n']} acc={q['agreement']:.3f} F1={q['macro_f1']:.3f} P50={t['p50_ms']:.2f} P95={t['p95_ms']:.2f}")
