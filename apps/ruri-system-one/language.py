"""Whole-sentence ja/en task; separate from the existing attitude contract."""
import math
from attitude import current_chunk

PUBLIC_MODEL = 'ruri-v3-30m-sentence-language'
TRAINING_MODEL = PUBLIC_MODEL + '-prototype'
LABELS = ('ja', 'en')
PREFIX = 'トピック: '


def validate_request(body):
    if not isinstance(body, dict) or set(body) != {'model', 'state', 'questions'} or body['model'] != PUBLIC_MODEL:
        raise ValueError('request must specify the sentence-language model, state and questions')
    text = current_chunk(body['state'])
    questions = body['questions']
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 64:
        raise ValueError('one or more sentence-language questions required (max 64)')
    for key, question in questions.items():
        if not isinstance(key, str) or not isinstance(question, dict) or set(question) != {'type', 'instructions', 'criteria'}:
            raise ValueError('invalid sentence-language question')
        if question['type'] != 'choice' or not isinstance(question['instructions'], str) or not question['instructions'].strip():
            raise ValueError('sentence language supports choice only, with instructions')
        criteria = question['criteria']
        if not isinstance(criteria, dict) or set(criteria) != set(LABELS):
            raise ValueError('sentence language requires both named ja/en criteria')
        if any(not isinstance(v, str) or not v.strip() for v in criteria.values()):
            raise ValueError('criteria descriptions must be nonempty')
    return text, questions


def choice_answer(logit, temperature):
    if not math.isfinite(logit) or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid language classifier score or temperature')
    scaled = logit / temperature
    if scaled >= 0:
        en = 1 / (1 + math.exp(-scaled))
    else:
        exponent = math.exp(scaled)
        en = exponent / (1 + exponent)
    probabilities = {'ja': 1 - en, 'en': en}
    choice = 'en' if logit > 0 else 'ja'
    return {'type': 'choice', 'choice': choice, 'confidence': probabilities[choice],
            'answer_confidence': probabilities[choice], 'probabilities': probabilities,
            'logits': {'ja': 0.0, 'en': logit}, 'calibrated': True,
            'score_kind': 'temperature_scaled_classifier_softmax',
            'calibration_label_status': 'synthetic-provisional'}
