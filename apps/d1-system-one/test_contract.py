import copy
import unittest
from contract import PUBLIC_MODEL, adapt_response, validate_request


def request():
    return {'model': PUBLIC_MODEL, 'state': {'player_x': 1, 'target_x': 3},
            'questions': {'move': {'type': 'choice', 'instructions': 'Move toward the target',
                                    'criteria': {'left': 'Move left', 'right': 'Move right'}}}}


class ContractTests(unittest.TestCase):
    def test_structured_game_state_and_unmodified_named_options(self):
        body = request()
        state, questions, images = validate_request(body)
        self.assertEqual(state, body['state'])
        self.assertEqual(questions, body['questions'])
        self.assertEqual(images, [])
        self.assertEqual(body, request())

    def test_list_choices_and_ordered_score_criteria(self):
        body = request()
        body['questions']['move']['criteria'] = ['left', 'right']
        body['questions']['risk'] = {'type': 'score', 'instructions': 'Risk', 'criteria': {'low': 'safe', 'high': 'danger'}}
        _, questions, _ = validate_request(body)
        self.assertEqual(questions['move']['criteria'], {'left': 'left', 'right': 'right'})
        self.assertEqual(questions['risk']['criteria'], ['safe', 'danger'])

    def test_null_state_requires_one_inline_image_and_urls_are_rejected(self):
        body = request()
        body['state'] = None
        with self.assertRaises(ValueError): validate_request(body)
        body['images'] = ['data:image/png;base64,YQ==']
        self.assertEqual(validate_request(body)[2], body['images'])
        for images in [['https://example.com/board.png'], [body['images'][0]] * 2, ['data:image/svg+xml;base64,YQ==']]:
            invalid = {**body, 'images': images}
            with self.assertRaises(ValueError): validate_request(invalid)

    def test_model_binding_and_invalid_questions_fail_closed(self):
        for mutation in ['model', 'type', 'criteria', 'extra', 'too-many', 'score', 'duplicate']:
            body = request()
            if mutation == 'model': body['model'] = 'laya-multilingual'
            if mutation == 'type': body['questions']['move']['type'] = 'chat'
            if mutation == 'criteria': body['questions']['move'].pop('criteria')
            if mutation == 'extra': body['url'] = 'http://localhost/'
            if mutation == 'too-many': body['questions'] = {str(i): copy.deepcopy(body['questions']['move']) for i in range(17)}
            if mutation == 'score': body['questions']['move'] = {'type': 'score', 'instructions': 'risk', 'criteria': ['one']}
            if mutation == 'duplicate': body['questions']['move']['criteria'] = ['left', 'left']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): validate_request(body)

    def test_native_noul_is_adapted_to_larm_without_changing_probability(self):
        questions = {'safe': {'type': 'noul', 'instructions': 'Safe?'}}
        result = adapt_response({'answers': {'safe': {'type': 'noul', 'noul': .2}},
                                 'usage': {'input_tokens': 4, 'output_tokens': 0}}, questions)
        self.assertEqual(result['model'], PUBLIC_MODEL)
        self.assertEqual(result['answers']['safe']['noul'], .2)
        self.assertEqual(result['answers']['safe']['confidence'], .8)
        for probability in [float('nan'), float('inf'), -1, 2]:
            with self.assertRaises(RuntimeError):
                adapt_response({'answers': {'safe': {'type': 'noul', 'noul': probability}}}, questions)

    def test_wrong_answer_sets_and_unoffered_actions_are_rejected(self):
        _, questions, _ = validate_request(request())
        for answers in [{}, {'move': {'type': 'choice', 'choice': 'jump', 'confidence': .99}},
                        {'move': {'type': 'noul', 'noul': .9}}]:
            with self.assertRaises(RuntimeError): adapt_response({'answers': answers}, questions)


if __name__ == '__main__': unittest.main()
