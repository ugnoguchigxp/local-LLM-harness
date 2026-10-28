"""In-memory decoding and ordered upstream annotation export; no media persistence."""
import base64
import io
import warnings

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

