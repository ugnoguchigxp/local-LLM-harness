"""In-memory decoding and ordered upstream annotation export; no media persistence."""
import base64
import io
import warnings

import numpy as np
from PIL import Image, ImageOps

from contract import MAX_PIXELS, Rejected


def decode_image(raw, media_type):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as opened:
                if opened.format != {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[media_type]:
                    raise Rejected("image_media_type_mismatch")
                if getattr(opened, "n_frames", 1) != 1:
                    raise Rejected("animated_image_forbidden")
                w, h = opened.size
                if min(w, h) < 1 or max(w, h) > 8192 or w * h > MAX_PIXELS:
                    raise Rejected("image_dimensions_exceeded", 413)
                opened.verify()
            with Image.open(io.BytesIO(raw)) as opened:
                return ImageOps.exif_transpose(opened).convert("RGB")
    except Rejected:
        raise
    except Exception as error:
        raise Rejected("invalid_image") from error


def export_result(result, task, image):
    from wevisone_vl.visualization import REF_RE, parse_predictions
    if len(result.response) > 65_536:
        raise Rejected("output_too_large", 502)
    detections = []
    # Parsing each ref independently preserves A, B, A ordering for OBJ masks.
    for match in REF_RE.finditer(result.response if task != "describe" else ""):
        for label, annotations in parse_predictions(match[0], *image.size).items():
            for item in annotations:
                if item["type"] != "box":
                    continue
                box = item["coords"]
                if not all(np.isfinite(box)) or min(box) < 0 or box[2] > image.width or box[3] > image.height:
                    raise Rejected("invalid_model_coordinates", 502)
                detection = {"label": label, "box": box}
                if task in {"ocr", "ocr_grounding"}:
                    detection["text"] = label
                detections.append(detection)
    if len(detections) > 128:
        raise Rejected("too_many_detections", 502)
    masks = []
    dense = task in {"segmentation", "matting"}
    if dense and len(detections) != len(result.masks):
        raise Rejected("mask_detection_mismatch", 502)
    if len(result.masks) > 8:
        raise Rejected("too_many_masks", 413)
    total = 0
    for index, mask in enumerate(result.masks):
        if not dense or len(result.boxes) != len(detections):
            raise Rejected("mask_detection_mismatch", 502)
        actual_box = np.array(detections[index]["box"]) / [image.width, image.height, image.width, image.height]
        if not np.allclose(actual_box, result.boxes[index], atol=1e-6):
            raise Rejected("mask_detection_mismatch", 502)
        if mask.shape != (image.height, image.width) or not np.isfinite(mask).all() or mask.min() < 0 or mask.max() > 1:
            raise Rejected("invalid_mask", 502)
        if task == "segmentation":
            pixels = (mask >= 0.5).astype(np.uint8) * 255
        else:
            pixels = np.rint(mask * 255).astype(np.uint8)
        if not pixels.any():
            raise Rejected("empty_mask", 502)
        output = io.BytesIO()
        Image.fromarray(pixels).save(output, format="PNG", compress_level=3)
        total += output.tell()
        if total > 4 * 1024 * 1024:
            raise Rejected("mask_output_too_large", 413)
        masks.append({"detectionIndex": index, "encoding": "png-base64",
                      "mode": "binary" if task == "segmentation" else "alpha",
                      "width": image.width, "height": image.height,
                      "data": base64.b64encode(output.getvalue()).decode("ascii")})
    return detections, masks
