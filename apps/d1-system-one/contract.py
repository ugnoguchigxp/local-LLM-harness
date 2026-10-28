"""Validation and response adaptation for a pinned, general game decision Provider."""
import math
import re

PUBLIC_MODEL = 'd1-2b-game'
REVISION = '97c57047d5852d77e02dfac211f8768aff77a8b2'
MAX_INPUT_TOKENS = 4096
MAX_IMAGE_BYTES = 2_000_000
MAX_IMAGE_PIXELS = 1_048_576
MAX_IMAGE_EDGE = 384
IDENTIFIER = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$')
IMAGE = re.compile(r'^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$')


def validate_request(body):
    if not isinstance(body, dict) or set(body) - {'model', 'state', 'questions', 'images'}:
        raise ValueError('request fields are model, state, questions and optional images')
    if not {'model', 'state', 'questions'} <= set(body) or body['model'] != PUBLIC_MODEL:
        raise ValueError('request must specify the claimed d1 game model, state and questions')
    images = body.get('images', [])
    if not isinstance(images, list) or len(images) > 1:
        raise ValueError('at most one inline image is supported')
    for image in images:
        if not isinstance(image, str) or len(image) > 2_800_000 or not IMAGE.fullmatch(image):
            raise ValueError('images must be bounded PNG/JPEG/WebP base64 data URLs')
    state = body['state']
    if state is None:
        if not images:
            raise ValueError('null state requires an image')
    elif isinstance(state, str):
        if not state.strip() or len(state) > 50_000:
            raise ValueError('state must contain 1 to 50000 characters')
    elif not isinstance(state, (dict, list)):
        raise ValueError('state must be text, an object, an array or null with an image')
    questions = body['questions']
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 16:
        raise ValueError('one to sixteen questions are supported')
    normalized = {}
    for name, question in questions.items():
        if not isinstance(name, str) or not IDENTIFIER.fullmatch(name) or not isinstance(question, dict):
            raise ValueError('invalid question identifier or question')
        if set(question) - {'type', 'instructions', 'criteria'}:
            raise ValueError('unsupported question fields')
        kind = question.get('type')
        instructions = question.get('instructions')
        if kind not in ('choice', 'score', 'noul') or not isinstance(instructions, str) or not instructions.strip() or len(instructions) > 16_384:
            raise ValueError('typed questions require nonempty instructions')
        criteria = question.get('criteria')
        if criteria is not None:
            if not isinstance(criteria, (dict, list)) or not 1 <= len(criteria) <= 100:
                raise ValueError('criteria must contain one to one hundred descriptions')
            values = criteria.values() if isinstance(criteria, dict) else criteria
            if any(not isinstance(v, str) or not v.strip() or len(v) > 4096 for v in values):
                raise ValueError('criteria descriptions must be nonempty strings')
            if isinstance(criteria, dict) and any(not isinstance(k, str) or not IDENTIFIER.fullmatch(k) for k in criteria):
                raise ValueError('invalid criterion identifier')
        if kind == 'choice':
            if criteria is None:
                raise ValueError('choice requires criteria')
            if isinstance(criteria, list):
                if len(set(criteria)) != len(criteria):
                    raise ValueError('choice descriptions must be unique')
                criteria = {value: value for value in criteria}
        elif kind == 'score':
            if criteria is None or not 2 <= len(criteria) <= 10:
                raise ValueError('score requires two to ten ordered descriptions')
            if isinstance(criteria, dict):
                criteria = list(criteria.values())
        elif criteria is not None and (not isinstance(criteria, dict) or set(criteria) != {'true', 'false'}):
            raise ValueError('noul criteria, when supplied, must name true and false')
        normalized[name] = {'type': kind, 'instructions': instructions}
        if criteria is not None:
            normalized[name]['criteria'] = criteria
    return state, normalized, images


def adapt_response(result, questions):
    if not isinstance(result, dict) or set(result.get('answers', {})) != set(questions):
        raise RuntimeError('model returned an invalid answer set')
    for name, question in questions.items():
        answer = result['answers'][name]
        if answer.get('type') != question['type']:
            raise RuntimeError('model returned an invalid answer type')
        if question['type'] == 'noul':
            p = answer.get('noul')
            if not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1:
                raise RuntimeError('model returned an invalid probability')
            answer['confidence'] = max(p, 1 - p)
        elif question['type'] == 'choice' and answer.get('choice') not in question['criteria']:
            raise RuntimeError('model selected an unoffered choice')
        if question['type'] == 'score':
            score = answer.get('score')
            if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= len(question['criteria']) - 1:
                raise RuntimeError('model returned an invalid score')
        confidence = answer.get('confidence')
        if not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise RuntimeError('model returned invalid confidence')
        probabilities = answer.get('probabilities', {})
        if any(not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()):
            raise RuntimeError('model returned invalid option probabilities')
    return {**result, 'model': PUBLIC_MODEL}
