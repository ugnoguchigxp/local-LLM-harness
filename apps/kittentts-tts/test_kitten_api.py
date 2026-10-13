import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave

import numpy as np
from fastapi.testclient import TestClient
from kitten_api import MODEL, create_app, verify_files


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.proceed = threading.Event()
        self.proceed.set()
        self.audio = np.array([0, 0.5, -0.5, 1.2], dtype=np.float32)

    def generate(self, text, **kwargs):
        self.calls.append((text, kwargs))
        self.entered.set()
        if not self.proceed.wait(5):
            raise RuntimeError("test synthesis timeout")
        return self.audio


class SpeechApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.client = TestClient(create_app(lambda: self.engine))
        self.client.__enter__()

    def tearDown(self):
        self.engine.proceed.set()
        self.client.__exit__(None, None, None)

    def request(self, **values):
        return self.client.post("/v1/audio/speech", json={"model": MODEL, "input": "Hello.", **values})

    def test_default_and_voice_switch_share_engine_with_number_preprocessing(self):
        first = self.request(input="  At 3:30 PM, I paid $12.50.  ")
        second = self.request(voice="Hugo", speed=1.2)
        self.assertEqual((first.status_code, second.status_code), (200, 200))
        self.assertEqual(self.engine.calls[0][0], "At 3:30 PM, I paid $12.50.")
        self.assertEqual(self.engine.calls[0][1], {"voice": "Rosie", "speed": 1.0, "clean_text": True})
        self.assertEqual(self.engine.calls[1][1]["voice"], "Hugo")
        self.assertEqual(self.engine.calls[1][1]["speed"], 1.2)
        with wave.open(io.BytesIO(first.content), "rb") as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (24000, 1, 2))
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        self.assertLessEqual(max(abs(samples)), 32113)

    def test_pcm_is_raw_signed_little_endian_24khz(self):
        response = self.request(response_format="pcm")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/pcm")
        self.assertEqual(len(response.content), 8)

    def test_catalog_identifies_rosie_and_hugo_and_supported_speed(self):
        response = self.client.get("/v1/audio/voices", params={"model": MODEL})
        catalog = response.json()
        self.assertEqual(catalog["default_voice"], "Rosie")
        voices = {voice["id"]: voice for voice in catalog["voices"]}
        self.assertEqual(voices["Rosie"]["voice_presentation"], "feminine")
        self.assertEqual(voices["Hugo"]["voice_presentation"], "masculine")
        self.assertEqual(voices["Rosie"]["language"], "en")
        self.assertEqual(voices["Hugo"]["capabilities"]["speed"]["maximum"], 2)
        self.assertEqual(self.client.get("/v1/audio/voices?model=wrong").status_code, 404)

    def test_rejects_wrong_model_voice_format_language_empty_input_and_unsupported_controls(self):
        for request, status in [({"model": "voicevox-core"}, 404), ({"voice": "alloy"}, 400),
                                ({"response_format": "mp3"}, 400), ({"input": "こんにちは Hello"}, 400),
                                ({"input": " "}, 400), ({"input": "..."}, 400),
                                ({"input": "x" * 4097}, 422), ({"speed": 0.1}, 422),
                                ({"pitch_scale": 0.1}, 422)]:
            with self.subTest(request=request):
                self.assertEqual(self.request(**request).status_code, status)
        self.assertEqual(self.engine.calls, [])

    def test_streaming_request_body_is_bounded_before_synthesis(self):
        body = json.dumps({"input": "x" * 70000}).encode()
        response = self.client.post("/v1/audio/speech", content=iter([body[:32000], body[32000:]]),
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.engine.calls, [])

    def test_busy_frontend_is_not_entered_twice_and_recovers(self):
        self.engine.proceed.clear()
        result = []
        worker = threading.Thread(target=lambda: result.append(self.request()))
        worker.start()
        self.assertTrue(self.engine.entered.wait(2))
        try:
            busy = self.request(voice="Hugo")
            self.assertEqual(busy.status_code, 429)
            self.assertEqual(busy.headers["retry-after"], "1")
            self.assertEqual(len(self.engine.calls), 1)
            self.assertEqual(self.client.get("/health").status_code, 200)
        finally:
            self.engine.proceed.set()
            worker.join(5)
        self.assertEqual(result[0].status_code, 200)
        self.assertEqual(self.request(voice="Hugo").status_code, 200)

    def test_invalid_audio_is_rejected_and_lock_released(self):
        for audio in [np.array([]), np.array([float("nan")])]:
            self.engine.audio = audio
            self.assertEqual(self.request().status_code, 502)
        self.engine.audio = np.zeros(100)
        self.assertEqual(self.request().status_code, 200)

    def test_wrong_artifact_checksum_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.onnx").write_bytes(b"wrong")
            with patch("kitten_api.PINNED_FILES", {"model.onnx": (5, "0" * 64)}):
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    verify_files(root)


if __name__ == "__main__":
    unittest.main()
