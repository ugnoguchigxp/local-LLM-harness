"""Provider failure handling and durable artifact contract without GPU inference."""
import base64
import importlib.util
import io
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("turbo_provider", Path(__file__).with_name("qwen-image21-turbo-provider.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TurboProviderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.provider = module.Provider(["unused"], "http://127.0.0.1:18291", Path(self.temp.name))
        self.provider.child = Mock()
        self.provider.child.poll.return_value = None

    def completed_image(self, size=(512, 512)):
        from PIL import Image
        stream = io.BytesIO()
        Image.new("RGB", size, "#125798").save(stream, format="PNG")
        return {"status": "completed", "result": {"images": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}}

    def install_job(self, result):
        self.provider.request = Mock(side_effect=[{"poll_url": "/sdcpp/v1/img_gen/test"}, result])

    def test_rejects_model_schedule_and_invalid_types_before_submission(self):
        self.provider.request = Mock()
        for override in ({"model": "qwen-image-2.1"}, {"steps": 40}, {"steps": True}, {"width": True}, {"seed": True}, {"seed": 2**53}, {"reference": "anything"}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.provider.generate({"prompt": "A photo", **override})
        self.provider.request.assert_not_called()

    @patch.object(module, "available_bytes", return_value=64 * 1024**3)
    def test_artifact_saved_with_matching_dimensions_hash_and_revision(self, _available):
        import hashlib
        self.install_job(self.completed_image())
        result = self.provider.generate({"prompt": "A photo", "format": "png", "seed": 42})
        artifact = result["artifact"]
        metadata_path = next(Path(self.temp.name).rglob("metadata.json"))
        metadata = json.loads(metadata_path.read_text())
        content = metadata_path.with_name(metadata["file"]).read_bytes()
        self.assertEqual(artifact["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(metadata["modelRevision"], module.MODEL_REVISION)
        self.assertEqual((artifact["width"], artifact["height"], artifact["steps"], artifact["seed"]), (512, 512, 8, 42))
        self.assertEqual(metadata_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(artifact["contentUrl"], f'/v1/image-artifacts/{artifact["id"]}/content')
        self.assertFalse(self.provider.generation_lock.locked())

    @patch.object(module, "available_bytes", return_value=64 * 1024**3)
    def test_bad_dimensions_and_failed_jobs_never_publish_an_artifact(self, _available):
        for result in (self.completed_image((768, 768)), {"status": "failed"}):
            self.install_job(result)
            with self.assertRaises(RuntimeError):
                self.provider.generate({"prompt": "A photo"})
            self.assertFalse(self.provider.generation_lock.locked())
        self.assertEqual(list(Path(self.temp.name).rglob("metadata.json")), [])

    @patch.object(module, "available_bytes", return_value=15 * 1024**3)
    def test_memory_floor_terminates_engine_and_releases_lock(self, _available):
        self.provider.request = Mock(return_value={"poll_url": "/sdcpp/v1/img_gen/test"})
        with self.assertRaisesRegex(RuntimeError, "memory floor"):
            self.provider.generate({"prompt": "A photo"})
        self.provider.child.terminate.assert_called_once()
        self.assertFalse(self.provider.generation_lock.locked())

    def test_engine_poll_urls_cannot_target_another_origin(self):
        for url in ("http://example.com/", "//example.com/v1/", "/private", "/v1/test?redirect=1"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                self.provider.request(url)

    def test_occupied_engine_port_is_not_taken_over(self):
        self.provider.child = None
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            self.provider.endpoint = f"http://127.0.0.1:{listener.getsockname()[1]}"
            with self.assertRaises(OSError):
                self.provider.start()
        self.assertIsNone(self.provider.child)


if __name__ == "__main__":
    unittest.main()
