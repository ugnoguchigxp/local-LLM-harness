"""Run with the prepared inference Python; these tests do not load model weights."""
import base64
import io
import os
import sys
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.environ.get("WEVISONE_SOURCE", "/srv/ai/apps/wevisone-vl-source-20261025"))
from contract import Rejected
from imaging import decode_image, export_result


def encoded(image, fmt="PNG", **kwargs):
    out = io.BytesIO()
    image.save(out, format=fmt, **kwargs)
    return out.getvalue()


class ImagingContract(unittest.TestCase):
    def test_decode_and_orientation(self):
        image = Image.new("RGB", (16, 32), "red")
        self.assertEqual(decode_image(encoded(image), "png").size, (16, 32))
        exif = Image.Exif(); exif[274] = 6
        self.assertEqual(decode_image(encoded(image, "JPEG", exif=exif), "jpeg").size, (32, 16))
        self.assertEqual(decode_image(encoded(image, "WEBP"), "webp").mode, "RGB")

    def test_invalid_corrupt_oversized_and_animated_images(self):
        image = Image.new("RGB", (8, 8), "red")
        for raw, mime in [(b"not an image", "png"), (encoded(image)[:-20], "png"),
                          (encoded(image), "jpeg"), (encoded(Image.new("RGB", (8193, 1))), "png"),
                          (encoded(Image.new("RGB", (2049, 2049))), "png"),
                          (encoded(image, "WEBP", save_all=True, append_images=[Image.new("RGB", (8, 8), "blue")], duration=10, loop=0), "webp")]:
            with self.assertRaises(Rejected):
                decode_image(raw, mime)

    def test_mask_order_and_precisions(self):
        image = Image.new("RGB", (16, 16))
        response = "<ref>A</ref><box><0><0><500><500><OBJ></box><ref>B</ref><box><500><0><1000><500><OBJ></box><ref>A</ref><box><0><500><500><1000><OBJ></box>"
        result = SimpleNamespace(response=response, boxes=[[0,0,.5,.5], [.5,0,1,.5], [0,.5,.5,1]], masks=[np.full((16,16), x, np.float32) for x in [.6,.7,.8]])
        detections, masks = export_result(result, "segmentation", image)
        self.assertEqual([d["label"] for d in detections], ["A", "B", "A"])
        self.assertEqual([m["detectionIndex"] for m in masks], [0,1,2])
        self.assertEqual(set(np.asarray(Image.open(io.BytesIO(base64.b64decode(masks[0]["data"])))) .ravel()), {255})
        _, alpha = export_result(result, "matting", image)
        self.assertEqual(np.asarray(Image.open(io.BytesIO(base64.b64decode(alpha[0]["data"]))))[0,0], 153)
        self.assertEqual(export_result(SimpleNamespace(response=response, boxes=[], masks=[]), "describe", image), ([], []))

    def test_mask_integrity(self):
        image = Image.new("RGB", (16, 16))
        value = {"response": "<ref>A</ref><box><0><0><500><500><OBJ></box>", "boxes": [[0,0,.5,.5]], "masks": [np.ones((16,16), np.float32)]}
        changes = [{"masks": []}, {"masks": [np.zeros((16,16))]}, {"masks": [np.full((16,16), float("nan"))]},
                   {"masks": [np.full((16,16), 1.1)]}, {"masks": [np.ones((8,8))]}, {"boxes": [[.1,0,.5,.5]]},
                   {"response": "<ref>A</ref><box><0><0><1001><500><OBJ></box>"}, {"masks": [np.ones((16,16))]*9}]
        for change in changes:
            with self.assertRaises(Rejected):
                export_result(SimpleNamespace(**{**value, **change}), "segmentation", image)


if __name__ == "__main__":
    unittest.main()
