import json
from pathlib import Path
import sys
import unittest
from attitude import LABELS, PUBLIC_MODEL, choice_answer, current_chunk, format_input, validate_request
from attitude import validate_contract


class AttitudeTests(unittest.TestCase):
    def test_expanded_contract_matches_benchmark_and_rejects_legacy_model_reuse(self):
        import copy
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'benchmarks/avatar-attitude'))
        from common import load_contract
        path = Path(__file__).with_name('contracts')/'expanded-v2-candidate.json'
        contract = validate_contract(json.loads(path.read_text()))
        self.assertEqual(contract, load_contract(path))
        body = self.request({label: label for label in contract['labels']})
        body['model'] = contract['public_model']
        validate_request(body, contract['labels'], contract['public_model'])
        with self.assertRaises(ValueError):
            validate_request(body)
        scores = [0.] * len(contract['labels'])
        scores[-1] = 5.
        result = choice_answer(scores, ['none'], labels=contract['labels'])
        self.assertEqual(result['choice'], 'none')
        self.assertEqual(result['answer_confidence'], 0.)
        self.assertEqual(len(result['probabilities']), 15)
        changed = copy.deepcopy(contract)
        changed['public_model'] = PUBLIC_MODEL
        with self.assertRaises(ValueError): validate_contract(changed)
        changed = copy.deepcopy(contract)
        changed['labels'][0], changed['labels'][1] = changed['labels'][1], changed['labels'][0]
        with self.assertRaises(ValueError): validate_contract(changed)

    def request(self, criteria=None):
        return {'model': PUBLIC_MODEL, 'state': {'response': '設定を開きます。', 'conversation': '悲しい、失敗した'},
                'questions': {'emotion': {'type': 'choice', 'instructions': '発話態度',
                                          'criteria': criteria or {label: label for label in LABELS}}}}

    def test_matches_training_format_and_never_uses_history(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'benchmarks/avatar-attitude'))
        from common import format_input as training_format
        text, _ = validate_request(self.request())
        self.assertEqual(format_input(text), 'トピック: ' + training_format({'current_chunk': text}, 'A'))
        self.assertNotIn('悲しい', format_input(text))
        self.assertEqual(current_chunk({'current_chunk': '現在', 'response': '全文'}), '現在')

    def test_rejects_general_decisions_and_wrong_model(self):
        body = self.request({'refund': '返金', 'other': 'その他'})
        with self.assertRaises(ValueError):
            validate_request(body)
        for model in ['laya-multilingual', 'ruri-v3-30m-sentence-language']:
            body = self.request()
            body['model'] = model
            with self.assertRaises(ValueError):
                validate_request(body)
        body = self.request()
        body['questions']['emotion']['type'] = 'score'
        with self.assertRaises(ValueError):
            validate_request(body)

    def test_abstains_when_best_class_is_excluded_without_renormalizing(self):
        logits = [0, 1, 8, 2, 3, 4]
        full = choice_answer(logits, LABELS)
        narrow = choice_answer(logits, ['none', 'warmth'])
        self.assertEqual(full['choice'], 'joy')
        self.assertEqual(narrow['choice'], 'none')
        self.assertEqual(narrow['answer_confidence'], 0)
        self.assertEqual(narrow['probabilities'], full['probabilities'])
        self.assertEqual(list(narrow['logits']), list(LABELS))
        self.assertFalse(full['calibrated'])

    def test_temperature_preserves_argmax_and_full_candidate_mass(self):
        logits = [0, 0, 2, 0, 0, 0]
        raw = choice_answer(logits, LABELS)
        scaled = choice_answer(logits, LABELS, .3)
        self.assertEqual(raw['choice'], scaled['choice'])
        self.assertGreater(scaled['answer_confidence'], raw['answer_confidence'])
        self.assertTrue(scaled['calibrated'])
        self.assertEqual(scaled['calibration_label_status'], 'synthetic-provisional')
        with self.assertRaises(ValueError):
            choice_answer(logits, LABELS, 0)

    def test_empty_response_cannot_fall_back_to_user_or_history(self):
        for state in ({'response': '', 'conversation': 'おめでとう'}, {'user': 'おめでとう'}, ['おめでとう']):
            with self.assertRaises(ValueError):
                current_chunk(state)

    def test_invalid_scores_fail_closed(self):
        for scores in ([0] * 5, [float('nan')] * 6, [float('inf')] * 6):
            with self.assertRaises(ValueError):
                choice_answer(scores, LABELS)

    def test_pins_derived_assets_outside_repository(self):
        manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
        self.assertEqual([e['path'] for e in manifest['files']], ['calibration.json', 'head.json', 'model.onnx', 'tokenizer.json'])
        self.assertTrue(manifest['preliminary'])
        self.assertTrue(all(len(e['sha256']) == 64 for e in manifest['files']))


if __name__ == '__main__':
    unittest.main()
