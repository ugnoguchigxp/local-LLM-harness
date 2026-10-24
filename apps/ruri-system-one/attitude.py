"""Frozen speaking-attitude contract; independent of benchmark/application code."""
LABELS = ('none', 'warmth', 'joy', 'empathy', 'curiosity', 'surprise')
INSTRUCTION = ('判断対象は現在の回答チャンクだけ。アシスタント自身がそのチャンクを話す表情と声色を選ぶ。'
               '文章中の感情やユーザーの感情を分類しない。引用、否定、技術上の失敗は感情表現ではない。')
PUBLIC_MODEL = 'ruri-v3-30m-speaking-attitude'


def validate_contract(value):
    """Validate an explicit, portable v2 contract; v1 remains the default."""
    import re
    required = {'schema_version', 'version', 'public_model', 'labels', 'criteria', 'input_mode', 'instruction'}
    if not isinstance(value, dict) or set(value) != required or value['schema_version'] != 1:
        raise ValueError('invalid attitude contract schema')
    labels = value['labels']
    if (not isinstance(labels, list) or not 3 <= len(labels) <= 64
            or any(not isinstance(l, str) or not re.fullmatch('[a-z][a-z0-9_]*', l) for l in labels)
            or len(set(labels)) != len(labels) or labels[0] != 'none'):
        raise ValueError('contract requires unique ordered labels starting with none')
    if (not isinstance(value['criteria'], dict) or set(value['criteria']) != set(labels)
            or any(not isinstance(v, str) or not v.strip() for v in value['criteria'].values())):
        raise ValueError('contract requires a description for each label')
    if (value['input_mode'] != 'A' or value['instruction'] != INSTRUCTION
            or not isinstance(value['version'], str) or not re.fullmatch('[a-z0-9][a-z0-9._-]*', value['version'])
            or not isinstance(value['public_model'], str)
            or not re.fullmatch('ruri-v3-30m-speaking-attitude-[a-z0-9][a-z0-9._-]*', value['public_model'])):
        raise ValueError('versioned contract must explicitly name a new model and retain input A')
    return value


def current_chunk(state):
    # Eumenes sends {response, conversation}. Never classify serialized history.
    text = state if isinstance(state, str) else state.get('current_chunk', state.get('response')) if isinstance(state, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 50_000:
        raise ValueError('state must be current text or contain a nonempty current_chunk/response string (max 50000 characters)')
    return text


def format_input(text):
    return 'トピック: ' + INSTRUCTION + '\n[アシスタント・現在チャンク・判断対象]\n' + text + '\n[/アシスタント・現在チャンク・判断対象]'


def validate_request(body, labels=LABELS, public_model=PUBLIC_MODEL):
    if not isinstance(body, dict) or set(body) != {'model', 'state', 'questions'} or body['model'] != public_model:
        raise ValueError('request must specify the speaking-attitude model, state and questions')
    text = current_chunk(body['state'])
    questions = body['questions']
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 64:
        raise ValueError('at least one speaking-attitude question is required (max 64)')
    for key, question in questions.items():
        if not isinstance(key, str) or not isinstance(question, dict):
            raise ValueError('invalid question')
        if set(question) != {'type', 'instructions', 'criteria'} or question['type'] != 'choice':
            raise ValueError('only speaking-attitude choice questions are supported')
        if not isinstance(question['instructions'], str) or not question['instructions'].strip():
            raise ValueError('instructions are required; the trained speaking-attitude task is fixed')
        criteria = question['criteria']
        if not isinstance(criteria, dict) or 'none' not in criteria or not set(criteria) <= set(labels):
            raise ValueError('criteria must be named speaking-attitude labels and include none')
        if any(not isinstance(v, str) or not v.strip() for v in criteria.values()):
            raise ValueError('criteria descriptions must be nonempty strings')
    return text, questions


def choice_answer(logits, offered, temperature=1.0, labels=LABELS, calibration_label_status='synthetic-provisional'):
    # Temperature may be fitted on held-out synthetic calibration examples.
    # The resulting score is not evidence of accuracy on real conversations.
    import math
    scores = [float(x) for x in logits]
    if len(scores) != len(labels) or not all(math.isfinite(x) for x in scores):
        raise ValueError('invalid classifier logits')
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("invalid calibration temperature")
    exp = [math.exp((x - max(scores)) / temperature) for x in scores]
    probabilities = {label: v / sum(exp) for label, v in zip(labels, exp)}
    best = labels[max(range(len(scores)), key=scores.__getitem__)]
    restricted = best not in offered
    choice = 'none' if restricted else best
    # Never renormalize a narrow candidate set into artificial confidence.
    score = probabilities[choice] if not restricted else 0.0
    return {'type': 'choice', 'choice': choice, 'confidence': score, 'answer_confidence': score,
            'probabilities': probabilities, 'logits': dict(zip(labels, scores)),
            'score_kind': 'temperature_scaled_classifier_softmax' if temperature != 1 else 'uncalibrated_classifier_softmax',
            'calibrated': temperature != 1, 'calibration_label_status': calibration_label_status if temperature != 1 else None,
            'candidate_restricted': restricted}
