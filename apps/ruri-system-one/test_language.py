import json
from pathlib import Path
import unittest
from language import PUBLIC_MODEL, PREFIX, LABELS, validate_request, choice_answer


class LanguageTests(unittest.TestCase):
    def request(self):
        return {'model': PUBLIC_MODEL, 'state': {'current_chunk': '現在の文章です。', 'response': '旧全文', 'conversation': 'English history'},
                'questions': {'language': {'type': 'choice', 'instructions': '文章全体の言語',
                                           'criteria': {'ja': '日本語文章', 'en': '英語文章'}}}}

    def test_only_current_text_and_named_binary_task(self):
        text, questions = validate_request(self.request())
        self.assertEqual(text, '現在の文章です。')
        self.assertNotIn('English history', PREFIX + text)
        self.assertEqual(set(questions['language']['criteria']), set(LABELS))

    def test_cannot_redefine_attitude_or_narrow_language_candidates(self):
        for mutation in ['model', 'type', 'subset', 'unknown', 'empty', 'instructions']:
            body = self.request()
            q = body['questions']['language']
            if mutation == 'model': body['model'] = 'ruri-v3-30m-speaking-attitude'
            if mutation == 'type': q['type'] = 'score'
            if mutation == 'subset': q['criteria'] = {'ja': '日本語'}
            if mutation == 'unknown': q['criteria'] = {'ja': '日本語', 'en': '英語', 'none': '未知'}
            if mutation == 'empty': body['state'] = ''
            if mutation == 'instructions': q['instructions'] = ''
            with self.assertRaises(ValueError): validate_request(body)

    def test_stable_binary_decision_and_calibration(self):
        self.assertEqual(choice_answer(-2, .05)['choice'], 'ja')
        self.assertEqual(choice_answer(2, .05)['choice'], 'en')
        self.assertEqual(choice_answer(0, .05)['choice'], 'ja')
        for logit in [-10000, -2, 0, 2, 10000]:
            result = choice_answer(logit, .05)
            self.assertAlmostEqual(sum(result['probabilities'].values()), 1)
            self.assertGreaterEqual(result['confidence'], .5)
        for logit, temperature in [(float('nan'), 1), (float('inf'), 1), (1, 0), (1, float('nan'))]:
            with self.assertRaises(ValueError): choice_answer(logit, temperature)

    def test_same_encoder_hashes_and_head_only_assets(self):
        root = Path(__file__).parent
        attitude = json.loads((root / 'assets.json').read_text())
        language = json.loads((root / 'language-assets.json').read_text())
        hashes = {r['path']: r['sha256'] for r in attitude['files']}
        self.assertEqual(language['encoder_sha256'], hashes['model.onnx'])
        self.assertEqual(language['tokenizer_sha256'], hashes['tokenizer.json'])
        self.assertEqual([r['path'] for r in language['files']], ['head.json'])
        self.assertEqual(language['revision'], attitude['revision'])


if __name__ == '__main__': unittest.main()
