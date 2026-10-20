"""General d1 contract and immutable, frozen-output head adapters (no base mutation)."""
import json
from contract import PUBLIC_MODEL, IDENTIFIER, validate_request

GENERAL_MODEL = 'd1-3b-general'
MAX_STATE_BYTES = 50_000


class DecisionError(ValueError):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def identity(value):
    return (isinstance(value, dict) and set(value) == {'id', 'version'}
            and isinstance(value['id'], str) and IDENTIFIER.fullmatch(value['id'])
            and type(value['version']) is int and value['version'] >= 1)


def validate_general(body):
    if set(body) - {'model', 'state', 'questions', 'images', 'adapter', 'questionSet'}:
        raise DecisionError('decision_invalid_request')
    if 'state' not in body or not isinstance(body['state'], (dict, str, type(None))):
        raise DecisionError('decision_invalid_request')
    if len(canonical(body['state']).encode()) > MAX_STATE_BYTES:
        raise DecisionError('decision_state_limit', 413)
    if not isinstance(body.get('questions'), dict) or not 1 <= len(body['questions']) <= 16:
        raise DecisionError('decision_question_limit')
    images = body.get('images', [])
    if not isinstance(images, list):
        raise DecisionError('decision_invalid_request')
    if len(images) > 1:
        raise DecisionError('decision_image_limit', 413)
    import base64
    for image in images:
        if isinstance(image, str) and ',' in image:
            try:
                if len(base64.b64decode(image.split(',', 1)[1], validate=True)) > 1024 * 1024:
                    raise DecisionError('decision_image_limit', 413)
            except (ValueError, TypeError) as error:
                if isinstance(error, DecisionError):
                    raise
                raise DecisionError('decision_invalid_request') from error
    if 'questionSet' in body and not identity(body['questionSet']):
        raise DecisionError('decision_invalid_request')
    if 'adapter' in body and (not identity(body['adapter']) or not identity(body.get('questionSet'))):
        raise DecisionError('decision_invalid_request')
    for q in body['questions'].values():
        if not isinstance(q, dict):
            raise DecisionError('decision_invalid_request')
        c = q.get('criteria')
        if q.get('type') == 'choice' and (not isinstance(c, dict) or len(c) < 2):
            raise DecisionError('decision_invalid_request')
        if q.get('type') == 'score' and not isinstance(c, list):
            raise DecisionError('decision_invalid_request')
    try:
        return validate_request({k: v for k, v in {**body, 'model': PUBLIC_MODEL}.items()
                                 if k not in ('adapter', 'questionSet')})
    except (ValueError, TypeError) as error:
        raise DecisionError('decision_invalid_request') from error

