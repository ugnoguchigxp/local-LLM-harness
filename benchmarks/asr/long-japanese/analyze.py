#!/usr/bin/env python3
"""Score literal/reading CER and explicitly annotated correction probes separately."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from functools import lru_cache
import json
import math
from pathlib import Path
import re
import statistics
import unicodedata

import pykakasi

CONVERTER = pykakasi.kakasi()
ALIASES = {'api':'エーピーアイ','cpu':'シーピーユー','gpu':'ジーピーユー'}


def normalize(text):
    text = unicodedata.normalize('NFKC',text).lower()
    return ''.join(c for c in text if not c.isspace() and unicodedata.category(c)[0] not in 'PZ')


def integer_kanji(n):
    if n == 0:
        return '零'
    digits = '零一二三四五六七八九'
    result = ''
    for unit,label in ((10**12,'兆'),(10**8,'億'),(10**4,'万'),(1000,'千'),(100,'百'),(10,'十')):
        if n >= unit:
            quotient,n = divmod(n,unit)
            result += ('' if quotient==1 and unit<10000 else integer_kanji(quotient)) + label
    return result + (digits[n] if n else '')


@lru_cache(maxsize=4096)
def canonical(text):
    text = unicodedata.normalize('NFKC',text).lower()
    text = re.sub(r'(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)',lambda m:m.group().replace(',',''),text)
    for key,value in ALIASES.items():
        text = re.sub(r'(?<![a-z])'+key+r'(?![a-z])',value,text)
    text = re.sub(r'\d+',lambda m:integer_kanji(int(m.group())) if len(m.group())<13 else m.group(),text)
    return normalize(text)


@lru_cache(maxsize=4096)
def reading(text):
    return normalize(''.join(part['hira'] for part in CONVERTER.convert(canonical(text))))


@lru_cache(maxsize=4096)
def edits(reference,hypothesis):
    previous = list(range(len(hypothesis)+1))
    table = [previous]
    for i,a in enumerate(reference,1):
        row = [i]
        for j,b in enumerate(hypothesis,1):
            row.append(min(row[-1]+1,previous[j]+1,previous[j-1]+(a!=b)))
        table.append(row);previous=row
    i,j=len(reference),len(hypothesis)
    counts=Counter(substitutions=0,deletions=0,insertions=0)
    while i or j:
        if i and j and reference[i-1]==hypothesis[j-1] and table[i][j]==table[i-1][j-1]:
            i-=1;j-=1
        elif i and j and table[i][j]==table[i-1][j-1]+1:
            counts['substitutions']+=1;i-=1;j-=1
        elif i and table[i][j]==table[i-1][j]+1:
            counts['deletions']+=1;i-=1
        else:
            counts['insertions']+=1;j-=1
    return {**counts,'edits':sum(counts.values()),'units':len(reference)}


def probe_score(reference,hypothesis,probe):
    # Exact lexical retention. Reading matches are supplementary, since
    # homophones can sound identical while changing the written meaning.
    source=canonical(probe['source'])
    expected=canonical(reference).count(source)
    observed=canonical(hypothesis).count(source)
    alternative_counts={s:max(0,canonical(hypothesis).count(canonical(s))
                              - observed*source.count(canonical(s))) for s in probe['alternatives']}
    if probe['kind']=='filler':
        # The alternatives here are spelling variants of the same filler.
        observed=max([observed,*alternative_counts.values()])
    return {**probe,'expected':expected,'observed':observed,'retained':min(expected,observed),
            'reading_observed':reading(hypothesis).count(reading(probe['source'])),
            'alternatives_observed':alternative_counts}


def quantile(values,q):
    if not values:
        return None
    values=sorted(values);position=(len(values)-1)*q;lower=math.floor(position);upper=math.ceil(position)
    return values[lower]+(values[upper]-values[lower])*(position-lower)


def score(row):
    ref,hyp=row['reference'],row['text']
    return {**row,'strict':edits(normalize(ref),normalize(hyp)),
            'canonical':edits(canonical(ref),canonical(hyp)),
            'reading':edits(reading(ref),reading(hyp)),
            'probes_scored':[probe_score(ref,hyp,p) for p in row['probes']]}


def aggregate(rows):
    quality=[r for r in rows if r['repeat']==0]
    result={'clips':len(quality),'attempts':len(rows),'failed_attempts':sum(bool(r['errors']) for r in rows),
            'failed_http_requests':sum(len(r['errors']) for r in rows),
            'audio_seconds_unique':sum(r['audio_seconds'] for r in quality),
            'latency_p50_s':quantile([r['seconds'] for r in rows],.5),
            'latency_p95_s':quantile([r['seconds'] for r in rows],.95),
            'final_segment_p50_s':quantile([r['last_segment_seconds'] for r in rows],.5),
            'segment_p50_s':quantile([s for r in rows for s in r['segment_seconds']],.5),
            'segment_p95_s':quantile([s for r in rows for s in r['segment_seconds']],.95),
            'rtf_p50':quantile([r['rtf'] for r in rows],.5),
            'aggregate_rtf':sum(r['seconds'] for r in rows)/sum(r['audio_seconds'] for r in rows),
            'nonempty_control_clips':sum(bool(normalize(r['text'])) for r in quality if r['condition']=='control')}
    for metric in ('strict','canonical','reading'):
        units=sum(r[metric]['units'] for r in quality)
        result[metric]={name:sum(r[metric][name] for r in quality) for name in ('units','edits','substitutions','deletions','insertions')}
        result[metric]['cer']=result[metric]['edits']/units if units else None
    groups=defaultdict(list)
    for row in quality:
        for p in row['probes_scored']:
            groups[p['kind']].append(p)
    result['probes']={kind:{'events':sum(p['expected'] for p in ps),'retained':sum(p['retained'] for p in ps),
                            'retention':sum(p['retained'] for p in ps)/sum(p['expected'] for p in ps),
                            'alternative_hits_when_source_missing':sum(sum(p['alternatives_observed'].values()) for p in ps
                                                                       if p['observed']<p['expected']),
                            'missing':[p['source'] for p in ps if p['retained']<p['expected']]}
                      for kind,ps in groups.items() if sum(p['expected'] for p in ps)}
    unique=defaultdict(set)
    for row in rows:
        unique[row['clip_id']].add(row['text'])
    result['inconsistent_clips']=sum(len(texts)>1 for texts in unique.values())
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True,action='append')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    rows=[score(json.loads(line)) for path in args.input for line in path.read_text().splitlines() if line]
    rows=[r for r in rows if r['repeat']>=0]
    grouped=defaultdict(list)
    for row in rows:
        grouped[(row['method'],row['condition'])].append(row)
    summary=[{'method':method,'condition':condition,**aggregate(group)} for (method,condition),group in sorted(grouped.items())]
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    methods=sorted({r['method'] for r in rows})
    stress_ids={r['text_id'] for r in rows if r['condition']=='noise15db'}
    subgroups=[]
    for method in methods:
        for label,predicate in [
            ('clean_kasukabe',lambda r:r['condition']=='clean' and r['voice']=='Kasukabe_Tsumugi'),
            ('clean_zundamon',lambda r:r['condition']=='clean' and r['voice']=='Zundamon'),
            ('clean_stress_matched',lambda r:r['condition']=='clean' and r['voice']=='Kasukabe_Tsumugi' and r['text_id'] in stress_ids),
        ]:
            group=[r for r in rows if r['method']==method and predicate(r)]
            if group:
                subgroups.append({'method':method,'subset':label,**aggregate(group)})
    (args.output/'subgroups.json').write_text(json.dumps(subgroups,ensure_ascii=False,indent=2)+'\n')
    with (args.output/'scored.jsonl').open('w') as f:
        for row in rows:f.write(json.dumps(row,ensure_ascii=False)+'\n')
    cases=[{k:r[k] for k in ('clip_id','method','reference','text','errors','strict','canonical','reading','probes_scored')}
           for r in rows if r['repeat']==0]
    (args.output/'cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2)+'\n')
    columns=['method','condition','clips','attempts','failed_attempts','strict_cer','canonical_cer','reading_cer',
             'latency_p50_s','latency_p95_s','segment_p50_s','segment_p95_s','final_segment_p50_s','aggregate_rtf']
    with (args.output/'comparison.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader()
        for row in summary:
            writer.writerow({key:row[key[:-4]]['cer'] if key.endswith('_cer') else row[key] for key in columns})
    with (args.output/'transcripts.csv').open('w',encoding='utf-8-sig',newline='') as f:
        columns=['clip_id','method','reference','text','strict_cer','reading_cer']
        writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader()
        for row in cases:
            writer.writerow({key:(row[key[:-4]]['edits']/row[key[:-4]]['units'] if row[key[:-4]]['units'] else '')
                             if key.endswith('_cer') else row[key] for key in columns})
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
