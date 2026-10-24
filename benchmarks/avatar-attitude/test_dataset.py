import copy
from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from common import ROOT, load_contract, load_examples
from dataset import convert_rows, group_rows, prepare, split_groups

CONTRACT = ROOT.parents[1]/'apps/ruri-system-one/contracts/expanded-v2-candidate.json'


def fixture(labels, n=10):
    return [dict(id=f'{label}:{i}', label=label, user=None,
                 assistant=hashlib.sha256(f'{label}:{i}'.encode()).hexdigest(),
                 review_status='approved', source='synthetic') for label in labels for i in range(n)]


class DatasetTests(unittest.TestCase):
    def test_requires_review_and_preserves_source_and_hold(self):
        raw = fixture(['none', 'joy', 'anger'])
        raw[0].pop('review_status')
        with self.assertRaises(ValueError):
            convert_rows(raw, ['none', 'joy', 'anger'])
        raw[1]['review_status'] = 'hold'
        rows, excluded = convert_rows(raw, ['none', 'joy', 'anger'], True)
        first = next(r for r in rows if r['id']==raw[0]['id'])
        self.assertEqual(first['source_record'], raw[0])
        self.assertEqual(first['review_status'], 'file-attested')
        self.assertEqual(excluded, [{'id': raw[1]['id'], 'reason': 'hold'}])
        self.assertTrue(all(r['expression_transition']=='initial' for r in rows))

    def test_identical_A_input_with_conflicting_labels_is_rejected(self):
        raw = fixture(['none', 'joy', 'anger'])
        raw[10]['assistant'] = raw[0]['assistant']
        with self.assertRaisesRegex(ValueError, 'conflicting labels'):
            convert_rows(raw, ['none', 'joy', 'anger'])

    def test_union_of_group_alias_conversation_and_near_text(self):
        raw = fixture(['none'], 4)
        raw[0]['group'] = raw[1]['group'] = 'reviewer-template'
        raw[1]['assistant'] = '設定を確認してください。'
        raw[2]['assistant'] = '設定を確認してください！'
        raw[2]['conversation_id'] = raw[3]['conversation_id'] = 'real-conversation'
        raw[3]['chunk_order'] = 1
        rows, _ = convert_rows(raw, ['none'])
        groups, pairs, _ = group_rows(rows)
        self.assertEqual(len(groups), 1)
        self.assertTrue(pairs)
        self.assertEqual(groups[0][0]['source_record']['group'], 'reviewer-template')

    def test_split_is_deterministic_and_covers_all_15_and_17_classes(self):
        labels = load_contract(CONTRACT)['labels']
        for labels in (labels, labels+['warmth', 'empathy']):
            raw = fixture(labels)
            a, _ = convert_rows(raw, labels)
            b, _ = convert_rows(list(reversed(raw)), labels)
            ga, _, _ = group_rows(a)
            gb, _, _ = group_rows(b)
            first = split_groups(ga, labels)
            second = split_groups(gb, labels)
            self.assertEqual(first, second)
            for split in ('train', 'calibration', 'eval'):
                self.assertEqual(set(r['primary_label'] for r in first if r['split']==split), set(labels))
            self.assertEqual(Counter(r['split'] for r in first)['train'], len(raw)*.6)

    def test_legacy_eval_similarity_pins_the_whole_group(self):
        labels = ['none', 'joy', 'anger']
        rows, _ = convert_rows(fixture(labels), labels)
        reference = dict(id='legacy', current_chunk=rows[0]['current_chunk'])
        groups, _, pinned = group_rows(rows, [reference])
        result = split_groups(groups, labels, pinned_eval=pinned)
        self.assertEqual(next(r for r in result if r['id']==rows[0]['id'])['split'], 'eval')
        self.assertEqual(len(pinned), 1)

    def test_unsplittable_class_is_an_error(self):
        labels = ['none', 'joy', 'anger']
        rows, _ = convert_rows(fixture(labels, 2), labels)
        groups, _, _ = group_rows(rows)
        with self.assertRaisesRegex(ValueError, 'three independent groups'):
            split_groups(groups, labels)

    def test_atomic_external_dataset_export_and_no_overwrite(self):
        labels = load_contract(CONTRACT)['labels']
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/'reviewed.jsonl'
            source.write_text(''.join(json.dumps(r)+'\n' for r in fixture(labels)))
            reference = root/'legacy.jsonl'
            reference.write_text(json.dumps(dict(id='unrelated', current_chunk='別の評価文。', split='eval'))+'\n')
            manifest = prepare(source, CONTRACT, root/'prepared', reference_path=reference)
            self.assertEqual(len(load_examples(root/'prepared/examples.jsonl', labels)), 150)
            self.assertEqual(manifest['contract']['labels'], labels)
            self.assertEqual(manifest['data_sha256'], hashlib.sha256((root/'prepared/examples.jsonl').read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                prepare(source, CONTRACT, root/'prepared', reference_path=reference)
            with self.assertRaises(ValueError):
                prepare(source, CONTRACT, ROOT/'must-not-exist', reference_path=reference)


if __name__ == '__main__':
    unittest.main()
