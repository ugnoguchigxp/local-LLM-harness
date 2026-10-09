"""Frozen encoder + six-class logistic head, fitted using the train partition only."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import time
import numpy as np
import torch
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from common import ROOT, LABELS, format_input, load_examples, require_external, sha256, write_json
from runtime import Encoder

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--sandbox',required=True)
    p.add_argument('--model',choices=['ruri30','ruri70','modernbert30'],required=True)
    p.add_argument('--data',default=str(ROOT/'examples.jsonl'))
    p.add_argument('--output',required=True)
    p.add_argument('--select-c',action='store_true',help='select regularization on calibration conversations only')
    a=p.parse_args()
    output=require_external(a.output)
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(1729)
    manifest=json.loads((Path(a.sandbox)/'artifacts'/(a.model+'-manifest.json')).read_text())
    rows=load_examples(a.data)
    train=[r for r in rows if r['split']=='train']
    calibration=[r for r in rows if r['split']=='calibration']
    if set(r['primary_label'] for r in train)!=set(LABELS):
        raise ValueError('all six classes need training examples')
    encoder=Encoder(manifest,manifest['path'])
    for parameter in encoder.model.parameters(): parameter.requires_grad_(False)
    head=dict(model=a.model,revision=manifest['revision'],labels=LABELS,encoder_frozen=True,
              data_sha256=sha256(a.data),train_ids=[r['id'] for r in train],
              train_conversations=sorted({r['conversation_id'] for r in train}),
              train_template_groups=sorted({r['template_group'] for r in train}),
              train_only=True,hyperparameters={'default_C':10.,'max_iter':2000,'solver':'lbfgs','seed':1729},
              artifact_manifest=manifest,runtime={n:importlib.metadata.version(n) for n in ['torch','transformers','scikit-learn']},
              source_sha256=sha256(__file__),preliminary=True,modes={},
              regularization_selection='calibration Macro F1, tie favors smaller C' if a.select_c else 'fixed C=10',
              calibration_ids=[r['id'] for r in calibration] if a.select_c else [],
              candidate_C=[1.,10.,100.,1000.] if a.select_c else [10.])
    start=time.perf_counter()
    for mode in ['A','B','C']:
        x=np.stack([encoder.encode(manifest['input_prefix']+format_input(r,mode)) for r in train])
        y=np.array([LABELS.index(r['primary_label']) for r in train])
        x_cal=np.stack([encoder.encode(manifest['input_prefix']+format_input(r,mode)) for r in calibration]) if a.select_c else None
        y_cal=np.array([LABELS.index(r['primary_label']) for r in calibration])
        trials=[]
        for c in head['candidate_C']:
            candidate=LogisticRegression(C=c,max_iter=2000,solver='lbfgs',random_state=1729).fit(x,y)
            score=float(f1_score(y_cal,candidate.predict(x_cal),labels=list(range(6)),average='macro',zero_division=0)) if a.select_c else 0.
            trials.append((score,-c,candidate))
        classifier=max(trials,key=lambda t:(t[0],t[1]))[2]
        if classifier.classes_.tolist()!=list(range(6)):
            raise ValueError('head label order mismatch')
        head['modes'][mode]={'weights':classifier.coef_.tolist(),'bias':classifier.intercept_.tolist(),
                             'train_agreement':float(classifier.score(x,y)), 'C':classifier.C,
                             'calibration_trials':[{'C':-negative_c,'macro_f1':score} for score,negative_c,_ in trials]}
        print(a.model,mode,'train n=',len(train),flush=True)
    head['training_ms']=(time.perf_counter()-start)*1000
    write_json(output,head)
