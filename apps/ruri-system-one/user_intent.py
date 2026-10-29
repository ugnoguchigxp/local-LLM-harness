"""Pinned user-intent head and System One contract; never loads an Encoder."""
import hashlib
import json
from pathlib import Path
import re
import numpy as np
from intent_features import probabilities

PUBLIC_MODEL = 'ruri-v3-30m-user-intent-v1'
LABELS = ('request', 'chat', 'followup', 'noise', 'incomplete')
FILES = {'head.json', 'calibration.json', 'encoder-manifest.json', 'dataset-manifest.json'}


def load_head(root, encoder_manifest, manifest_path=None):
    root = Path(root)
    if root.is_symlink():
        raise ValueError('intent root must be an immutable directory')
    manifest = json.loads(Path(manifest_path or Path(__file__).with_name('assets-intent.json')).read_text())
    entries = manifest.get('files', [])
    if manifest.get('model') != PUBLIC_MODEL or len(entries) != 4 or {e['path'] for e in entries} != FILES:
        raise ValueError('invalid intent asset manifest')
    hashes = {}
    for entry in entries:
        path = root / entry['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes']:
            raise ValueError('missing intent artifact')
        hashes[entry['path']] = hashlib.sha256(path.read_bytes()).hexdigest()
        if hashes[entry['path']] != entry['sha256']:
            raise ValueError('intent artifact checksum mismatch')
    head = json.loads((root/'head.json').read_text())
    calibration = json.loads((root/'calibration.json').read_text())
    dataset = json.loads((root/'dataset-manifest.json').read_text())
    expected_encoder = {e['path']:e['sha256'] for e in encoder_manifest['files'] if e['path'] in ('model.onnx','tokenizer.json')}
    if (head.get('model') != PUBLIC_MODEL or head.get('labels') != list(LABELS)
            or head.get('revision') != encoder_manifest['revision']
            or head.get('encoder_hashes') != expected_encoder
            or head.get('feature_mode') != 'current-plus-context-charhash'
            or head.get('encoder_frozen') is not True or head.get('train_only') is not True
            or head.get('input_contract', {}).get('version') != 'previous-agent-first160-user-latest-v1'
            or head.get('dataset_manifest_sha256') != hashes['dataset-manifest.json']):
        raise ValueError('intent head/encoder provenance mismatch')
    train, cal = head.get('train_ids', []), head.get('calibration_ids', [])
    if (not train or not cal or len(set(train)) != len(train) or len(set(cal)) != len(cal) or set(train) & set(cal)
            or any(dataset['split_by_id'].get(i) != 'fit' for i in train)
            or any(dataset['split_by_id'].get(i) != 'calibration' for i in cal)
            or calibration.get('head_sha256') != hashes['head.json'] or calibration.get('calibration_ids') != cal):
        raise ValueError('intent calibration/training provenance mismatch')
    weights, bias = np.asarray(head['weights'],dtype=np.float32), np.asarray(head['bias'],dtype=np.float32)
    if weights.shape != (5,4608) or bias.shape != (5,) or not np.isfinite(weights).all() or not np.isfinite(bias).all():
        raise ValueError('invalid intent head values')
    temperature = calibration['temperature']
    if isinstance(temperature,bool):
        raise ValueError('invalid intent temperature')
    probabilities([0.]*5,temperature)
    return dict(weights=weights,bias=bias,temperature=temperature,label_status=head['label_status'],
                head_revision='sha256:'+hashes['head.json'],calibration_revision='sha256:'+hashes['calibration.json'])


def validate_request(body):
    if not isinstance(body,dict) or set(body) != {'model','state','questions'} or body['model'] != PUBLIC_MODEL:
        raise ValueError('request must specify the user-intent model, state and questions')
    state = body['state']
    if isinstance(state,str):
        state = {'text':state,'previous_agent':None}
    if not isinstance(state,dict) or not {'text'} <= set(state) or not set(state) <= {'text','previous_agent'}:
        raise ValueError('intent state requires text and optional previous_agent')
    text, previous = state['text'], state.get('previous_agent')
    if not isinstance(text,str) or not text.strip() or len(text) > 50_000:
        raise ValueError('intent text must be nonempty (max 50000 characters)')
    if previous is not None and (not isinstance(previous,str) or not previous.strip() or len(previous)>50_000):
        raise ValueError('previous_agent must be nonempty text or null (max 50000 characters)')
    questions = body['questions']
    if not isinstance(questions,dict) or not 1 <= len(questions) <= 64:
        raise ValueError('1..64 intent questions required')
    for key, q in questions.items():
        if (not isinstance(key,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}',key)
                or not isinstance(q,dict) or set(q) != {'type','instructions','criteria'}
                or q['type'] != 'choice' or not isinstance(q['instructions'],str) or not q['instructions'].strip()
                or not isinstance(q['criteria'],dict) or set(q['criteria']) != set(LABELS)
                or any(not isinstance(v,str) or not v.strip() for v in q['criteria'].values())):
            raise ValueError('intent requires choice questions with all five named labels; trained task is fixed')
    return {'text':text,'previous_agent':previous}, questions


def answer(logits, head):
    scores = probabilities(logits,head['temperature'])
    best = int(scores.argmax())
    return dict(type='choice',choice=LABELS[best],confidence=float(scores[best]),answer_confidence=float(scores[best]),
                probabilities=dict(zip(LABELS,scores.tolist())),logits=dict(zip(LABELS,logits.tolist())),
                calibrated=True,calibration_label_status=head['label_status'],score_kind='temperature_scaled_classifier_softmax')
