import copy
import unittest
from general import DecisionError, GENERAL_MODEL, validate_general


def request():
    questions = {
        'yes': {'type': 'noul', 'instructions': '許可済みですか？'},
        'choice': {'type': 'choice', 'instructions': '分類', 'criteria': {'a': '許可', 'b': '禁止'}},
        'score': {'type': 'score', 'instructions': '危険度', 'criteria': ['低い', '高い']},
    }
    return {'model': GENERAL_MODEL, 'state': {'action': '許可済み'},
            'questions': {f'q{i}': copy.deepcopy(list(questions.values())[i % 3]) for i in range(12)}}


class GeneralTests(unittest.TestCase):
    def test_mixed_twelve_questions_preserve_japanese_definitions(self):
        body = request()
        state, questions, images = validate_general(body)
        self.assertEqual(state, body['state'])
        self.assertEqual(questions, body['questions'])
        self.assertEqual(len(questions), 12)
        self.assertEqual(images, [])

    def test_limits_and_question_types_fail_with_stable_codes(self):
        for field, value, code in [('state', 'あ' * 17_000, 'decision_state_limit'),
                                    ('images', [1, 2], 'decision_image_limit'),
                                    ('questions', {f'q{i}': request()['questions']['q0'] for i in range(17)}, 'decision_question_limit')]:
            body = request(); body[field] = value
            with self.subTest(field=field), self.assertRaises(DecisionError) as caught:
                validate_general(body)
            self.assertEqual(caught.exception.code, code)
        body = request(); body['questions']['q1']['criteria'] = ['yes', 'no']
        with self.assertRaises(DecisionError): validate_general(body)


if __name__ == '__main__': unittest.main()
