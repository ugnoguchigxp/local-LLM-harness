"""Review-aware JSONL import and deterministic, leakage-resistant group splits."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import random
import tempfile

from common import ROOT, load_contract, load_examples, near_targets, normalized_target, require_external, sha256, write_json

SPLITS = ('train', 'calibration', 'eval')
RATIOS = (.6, .2, .2)
APPROVED = {'approved', 'reviewed', 'human-reviewed'}
EXCLUDED = {'pending', 'hold', 'rejected', 'excluded', 'unreviewed'}


def read_jsonl(path):
    rows = []
    for n, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as error:
            raise ValueError(f'invalid JSON at line {n}') from error
        if not isinstance(row, dict):
            raise ValueError(f'expected an object at line {n}')
        rows.append(row)
    if not rows:
        raise ValueError('empty dataset')
    return rows


def convert_rows(raw, labels, reviewed_input=False):
    rows, excluded, seen = [], [], set()
    for source in raw:
        identity = source.get('id')
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError('missing or duplicate sample id')
        seen.add(identity)
        status = source.get('review_status')
        if status in EXCLUDED:
            excluded.append({'id': identity, 'reason': status})
            continue
        if status is not None and status not in APPROVED:
            raise ValueError('unknown review_status: ' + str(status))
        if status is None and not reviewed_input:
            raise ValueError('missing review status; attest a reviewed file with --reviewed-input')
        label = source.get('primary_label', source.get('label'))
        acceptable = source.get('acceptable_labels', [label])
        text = source.get('current_chunk', source.get('assistant'))
        user = source.get('user_utterance', source.get('user'))
        if (label not in labels or not isinstance(acceptable, list) or label not in acceptable
                or any(not isinstance(l, str) or l not in labels for l in acceptable)):
            raise ValueError('invalid reviewed labels: ' + identity)
        if not isinstance(text, str) or not text.strip() or len(text) > 50_000:
            raise ValueError('invalid current chunk: ' + identity)
        if user is not None and not isinstance(user, str):
            raise ValueError('invalid user text: ' + identity)
        cid = source.get('conversation_id')
        independent = cid is None
        if cid is None:
            cid = 'sample:' + identity
        order = source.get('chunk_order', 0)
        template = source.get('template_group', source.get('template_group_id', source.get('group', 'sample:' + identity)))
        tags = source.get('tags', [])
        if (not isinstance(cid, str) or not cid or not isinstance(template, str) or not template
                or type(order) is not int or order < 0 or (independent and order != 0)
                or not isinstance(tags, list) or any(not isinstance(t, str) for t in tags)):
            raise ValueError('invalid conversation/template metadata: ' + identity)
        rows.append(dict(id=identity, conversation_id=cid, template_group=template, chunk_order=order,
                         current_chunk=text, user_utterance=user or '', primary_label=label,
                         acceptable_labels=acceptable, tags=tags,
                         label_status=source.get('label_status', 'reviewed-labels-unverified-distribution'),
                         review_status=status or 'file-attested',
                         conversation_provenance='independent-sample' if independent else 'supplied',
                         source_record=source))
    if not rows:
        raise ValueError('no reviewed examples remain')
    by_conversation = defaultdict(list)
    targets = {}
    for row in rows:
        by_conversation[row['conversation_id']].append(row)
        target = normalized_target(row['current_chunk'])
        if target in targets and targets[target] != row['primary_label']:
            raise ValueError('conflicting labels for an identical input A target: ' + row['id'])
        targets[target] = row['primary_label']
    for sequence in by_conversation.values():
        sequence.sort(key=lambda r: r['chunk_order'])
        for i, row in enumerate(sequence):
            if row['chunk_order'] != i:
                raise ValueError('conversation chunks must be contiguous from zero')
            expected = 'initial' if i == 0 else ('hold' if row['primary_label'] == sequence[i-1]['primary_label'] else 'change')
            supplied = row['source_record'].get('expression_transition')
            if supplied is not None and supplied != expected:
                raise ValueError('transition contradicts reviewed primary labels')
            row['expression_transition'] = expected
            row['transition_provenance'] = 'supplied' if supplied is not None else 'derived-from-labels'
    return sorted(rows, key=lambda r: r['id']), excluded


def group_rows(rows, reference_eval=()):
    """Union conversation, explicit template and lexical similarity edges."""
    parent = list(range(len(rows)))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(i, j):
        parent[root(j)] = root(i)
    mappings = [dict(), dict()]
    pairs = []
    for i, row in enumerate(rows):
        for mapping, field in zip(mappings, ('conversation_id', 'template_group')):
            key = row[field]
            if key in mapping:
                union(i, mapping[key])
            mapping[key] = i
        for j in range(i):
            if near_targets(row['current_chunk'], rows[j]['current_chunk']):
                union(i, j)
                pairs.append([rows[j]['id'], row['id']])
    groups = defaultdict(list)
    for i, row in enumerate(rows):
        groups[root(i)].append(row)
    pinned = set()
    references = list(reference_eval)
    for members in groups.values():
        identity = 'group:' + hashlib.sha256(json.dumps(sorted(r['id'] for r in members)).encode()).hexdigest()[:24]
        for row in members:
            # Original grouping fields remain intact in source_record.
            row['template_group'] = identity
        if any(row['id'] == ref['id'] or row['conversation_id'] == ref.get('conversation_id')
               or (ref.get('template_group') is not None and
                   row['source_record'].get('template_group', row['source_record'].get('template_group_id', row['source_record'].get('group'))) == ref['template_group'])
               or near_targets(row['current_chunk'], ref['current_chunk'])
               for row in members for ref in references):
            pinned.add(identity)
    return sorted(groups.values(), key=lambda g: g[0]['id']), pairs, pinned


def split_groups(groups, labels, seed=1729, pinned_eval=()):
    counts = Counter(r['primary_label'] for g in groups for r in g)
    if set(counts) != set(labels):
        raise ValueError('all contract classes require reviewed examples')
    for label in labels:
        if sum(any(r['primary_label'] == label for r in group) for group in groups) < 3:
            raise ValueError('at least three independent groups per class are required: ' + label)
    targets = [{l: counts[l] * ratio for l in labels} for ratio in RATIOS]
    best = None
    for attempt in range(32):
        rng = random.Random(seed + attempt)
        ordered = list(groups)
        rng.shuffle(ordered)
        ordered.sort(key=len, reverse=True)
        assigned = [[], [], []]
        observed = [Counter(), Counter(), Counter()]
        for group in ordered:
            if group[0]['template_group'] in pinned_eval:
                assigned[2].extend(group)
                observed[2].update(r['primary_label'] for r in group)
        for group in ordered:
            if group[0]['template_group'] in pinned_eval:
                continue
            addition = Counter(r['primary_label'] for r in group)
            costs = []
            for s in range(3):
                delta = sum(((observed[s][l] + n - targets[s][l])**2
                             - (observed[s][l] - targets[s][l])**2) / max(targets[s][l], 1)
                            for l, n in addition.items())
                costs.append((delta, rng.random(), s))
            chosen = min(costs)[2]
            assigned[chosen].extend(group)
            observed[chosen].update(addition)
        if any(set(c) != set(labels) for c in observed):
            continue
        objective = sum((observed[s][l] - targets[s][l])**2 / max(targets[s][l], 1)
                        for s in range(3) for l in labels)
        if best is None or objective < best[0]:
            best = objective, assigned
    if best is None:
        raise ValueError('cannot cover all classes in independent splits; add groups or revise grouping')
    result = []
    for split, assigned in zip(SPLITS, best[1]):
        for row in assigned:
            result.append(dict(row, split=split))
    return sorted(result, key=lambda r: r['id'])


def prepare(source, contract_path, output, reviewed_input=False, seed=1729, reference_path=ROOT/'examples.jsonl'):
    output = require_external(output)
    if output.exists():
        raise ValueError('output exists; use a new dataset revision directory')
    contract = load_contract(contract_path)
    raw = read_jsonl(source)
    rows, excluded = convert_rows(raw, contract['labels'], reviewed_input)
    reference = [r for r in read_jsonl(reference_path) if r.get('split') == 'eval']
    groups, pairs, pinned = group_rows(rows, reference)
    result = split_groups(groups, contract['labels'], seed, pinned)
    manifest = dict(schema_version=1, source_sha256=sha256(source), contract=contract,
                    contract_sha256=sha256(contract_path), reference_eval_sha256=sha256(reference_path), seed=seed,
                    requested_ratios=dict(zip(SPLITS, RATIOS)), grouping='conversation + template + normalized bidirectional SequenceMatcher >= 0.8',
                    reviewed_input_attested=reviewed_input, excluded=excluded, near_pairs=pairs,
                    pinned_eval_groups=sorted(pinned),
                    audit=dict(input_rows=len(raw), included_rows=len(rows), excluded_rows=len(excluded),
                               null_user=sum(r.get('user', r.get('user_utterance')) is None for r in raw),
                               review_status=dict(Counter(r['review_status'] for r in rows)),
                               labels=dict(Counter(r['primary_label'] for r in rows)),
                               generators=dict(Counter(str(r.get('model')) for r in raw)),
                               sources=dict(Counter(str(r.get('source')) for r in raw)),
                               groups=len(groups), near_duplicate_pairs=len(pairs)),
                    splits={s: dict(ids=[r['id'] for r in result if r['split']==s],
                                    groups=sorted({r['template_group'] for r in result if r['split']==s}),
                                    labels=dict(Counter(r['primary_label'] for r in result if r['split']==s))) for s in SPLITS})
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.attitude-dataset-', dir=output.parent) as tmp:
        stage = Path(tmp)/'dataset'
        stage.mkdir()
        dataset = stage/'examples.jsonl'
        dataset.write_text(''.join(json.dumps(r, ensure_ascii=False)+'\n' for r in result))
        load_examples(dataset, contract['labels'])
        manifest['data_sha256'] = sha256(dataset)
        manifest['source_sha256'] = sha256(source)
        manifest['tool_sha256'] = sha256(__file__)
        write_json(stage/'manifest.json', manifest)
        write_json(stage/'audit.json', manifest['audit'])
        write_json(stage/'contract.json', contract)
        stage.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--reviewed-input', action='store_true', help='attest file review when per-row review_status is absent')
    parser.add_argument('--seed', type=int, default=1729)
    parser.add_argument('--reference-eval', default=str(ROOT/'examples.jsonl'))
    args = parser.parse_args()
    manifest = prepare(args.data, args.contract, args.output, args.reviewed_input, args.seed, args.reference_eval)
    print(json.dumps({'output': args.output, 'labels': manifest['contract']['labels'],
                      'splits': {s: sum(v['labels'].values()) for s,v in manifest['splits'].items()},
                      'excluded': len(manifest['excluded'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
