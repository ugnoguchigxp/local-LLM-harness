"""Bounded, native visual-perception request contract (no inference imports)."""
import base64
import re

MODEL = "lfm3-vl-2b"
REVISION = "7c3b4a43c9023e80bf234fec5e826a3365c8dda8"
SOURCE_REVISION = "40f735b8daed437ece982db9718e9c9856f52a79"
MAX_BYTES = 4 * 1024 * 1024
MAX_PIXELS = 4_194_304
TASKS = {"describe"}


class Rejected(ValueError):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


def validate_request(value):
    if not isinstance(value, dict) or set(value) - {"model", "image", "task", "query", "maxNewTokens"}:
        raise Rejected("invalid_visual_perception_request")
    if value.get("model") != MODEL:
        raise Rejected("model_mismatch")
    task, query = value.get("task"), value.get("query")
    if not isinstance(task, str) or task not in TASKS:
        raise Rejected("invalid_task")
    if isinstance(query, str):
        if len(query) > 2048 or (task != "ocr" and not query.strip()):
            raise Rejected("invalid_query")
    elif not (task == "detection" and isinstance(query, list) and 1 <= len(query) <= 32
              and all(isinstance(x, str) and 1 <= len(x) <= 128 and x.strip() for x in query)):
        raise Rejected("invalid_query")
    limit = value.get("maxNewTokens", 256)
    if type(limit) is not int or not 16 <= limit <= 512:
        raise Rejected("invalid_token_limit")
    image = value.get("image")
    if not isinstance(image, str) or len(image) > 5_600_000:
        raise Rejected("image_too_large", 413)
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})", image)
    if not match:
        raise Rejected("invalid_image_data_uri")
    try:
        raw = base64.b64decode(match[2], validate=True)
    except ValueError as error:
        raise Rejected("invalid_image_base64") from error
    if len(raw) > MAX_BYTES:
        raise Rejected("image_too_large", 413)
    return {**value, "maxNewTokens": limit}, raw, match[1]
