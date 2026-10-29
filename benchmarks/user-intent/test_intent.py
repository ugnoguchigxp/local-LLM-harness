"""Checks for supervision leakage, group isolation and probability calibration."""
from pathlib import Path
import tempfile
import unittest

import numpy as np
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace

from intent import LABELS, external, format_input, probabilities, surface_features
from train import groups_for, metrics, partition


class IntentTests(unittest.TestCase):
    def setUp(self):
        self.tokenizer = Tokenizer(WordLevel({'[UNK]':0, 'hello':1, 'world':2}, unk_token='[UNK]'))
        self.tokenizer.pre_tokenizer = Whitespace()

    def test_supervision_and_metadata_never_enter_input(self):
        row = dict(text='hello', previous_agent='world', label='request', toolchain='secret',
                   category='hidden', note='never include this', source='past')
        text, dropped = format_input(row, self.tokenizer)
        self.assertIn('hello', text)
        self.assertIn('world', text)
        self.assertEqual(dropped, 0)
        altered = dict(row, label='noise', toolchain='else', note='different')
        self.assertEqual(format_input(row,self.tokenizer), format_input(altered,self.tokenizer))

    def test_history_is_bounded_and_current_target_survives(self):
        text, dropped = format_input(dict(text='LATEST_TARGET', previous_agent='hello '*400), self.tokenizer)
        self.assertEqual(dropped,240)
        self.assertEqual(text.count('hello'),160)
        self.assertIn('LATEST_TARGET',text)

    def test_context_affects_input_and_null_has_explicit_marker(self):
        row = dict(text='hello', previous_agent=None)
        self.assertIn('（なし）',format_input(row,self.tokenizer)[0])
        self.assertNotEqual(format_input(row,self.tokenizer),format_input(dict(row,previous_agent='world'),self.tokenizer))

    def test_normalized_targets_and_near_variants_stay_together(self):
        rows = [dict(text='ＡＢＣ。'),dict(text='abc'),
                dict(text='明日の東京の天気を調べてください'),dict(text='明日の東京の天気を調べて下さい'),dict(text='今日はお疲れ様')]
        for i, row in enumerate(rows):row['id']=str(i)
        groups, _ = groups_for(rows)
        self.assertEqual(groups[0],groups[1])
        self.assertEqual(groups[2],groups[3])
        self.assertNotEqual(groups[2],groups[4])

    def test_calibration_has_independent_groups_and_all_labels(self):
        rows = [dict(id=f'{i}-{j}',text=f'{i}:{j}',source='past' if j%2 else 'synthetic',label=label)
                for i,label in enumerate(LABELS) for j in range(40)]
        groups = [str(i//2) for i in range(len(rows))]
        fit, calibration = partition(rows,groups)
        self.assertFalse(set(groups[i] for i in fit)&set(groups[i] for i in calibration))
        self.assertEqual({rows[i]['label'] for i in calibration},set(LABELS))
        self.assertEqual(len(fit)+len(calibration),len(rows))

    def test_temperature_is_stable_and_preserves_argmax(self):
        raw=np.array([[10000,9999,-10000,0,10],[0,0,0,0,0]],dtype=float)
        cold,warm=probabilities(raw,.2),probabilities(raw,3.)
        np.testing.assert_allclose(cold.sum(axis=1),1.)
        np.testing.assert_allclose(warm.sum(axis=1),1.)
        np.testing.assert_array_equal(cold.argmax(axis=1),warm.argmax(axis=1))
        self.assertGreater(cold[0,0],warm[0,0])
        with self.assertRaises(ValueError):probabilities(raw,0)

    def test_missed_requests_and_valid_utterances_lost_to_noise_are_separate(self):
        rows=[dict(label=l) for l in ['request','chat','followup','noise','incomplete']]
        logits=np.eye(5)[[1,3,0,3,4]]*10
        result=metrics(rows,logits,1.)
        self.assertEqual(result['correct'],2)
        self.assertEqual(result['request_missed'],1)
        self.assertEqual(result['nonrequest_as_request'],1)
        self.assertEqual(result['valid_as_noise'],1)

    def test_artifact_locations_must_be_external(self):
        with self.assertRaises(ValueError):external(Path(__file__).parent/'model.json')
        with tempfile.TemporaryDirectory() as path:self.assertEqual(external(path),Path(path).resolve())

    def test_character_features_are_stable_and_distinguish_fragment_endings(self):
        first=surface_features('東京の')
        np.testing.assert_array_equal(first,surface_features('東京の'))
        self.assertEqual(first.shape,(4096,))
        self.assertAlmostEqual(float(np.linalg.norm(first)),1.,places=6)
        self.assertFalse(np.array_equal(first,surface_features('東京の天気を調べて')))


if __name__ == '__main__':
    unittest.main()
