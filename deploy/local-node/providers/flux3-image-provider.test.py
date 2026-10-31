"""Exercise model separation and caption failure handling without loading weights."""
import base64
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("flux_provider", Path(__file__).with_name("flux3-image-provider.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FluxProviderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.provider = module.Provider(["unused", "--listen-port", "18095"], "http://127.0.0.1:18095",
            self.root, "leejet/flux-3-image-klein-GGUF", "a" * 40, self.root / "pup")
        self.provider.child = Mock()
        self.provider.child.poll.return_value = None

    def test_rejects_qwen_and_crossed_schedules_before_caption_or_submission(self):
        self.provider.request = Mock()
        with patch.object(module, "expand_caption") as expand:
            for override in ({"model": "qwen-image-2.1-turbo"}, {"steps": 8}, {"steps": True},
                    {"model": "flux-3-image-klein-base"}, {"width": 1281}, {"prompt": ""}):
                with self.subTest(override=override), self.assertRaises(ValueError):
                    self.provider.generate({"prompt": "A cat", **override})
            expand.assert_not_called()
        self.provider.request.assert_not_called()

    @patch.object(module.native, "available_bytes", return_value=64 * 1024**3)
    def test_flux_schedule_caption_alignment_and_artifact_provenance(self, _available):
        from PIL import Image
        stream = io.BytesIO()
        Image.new("RGB", (1216, 784), "blue").save(stream, format="PNG")
        result = {"status": "completed", "result": {"images": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}}
        self.provider.request = Mock(side_effect=[{"poll_url": "/sdcpp/v1/img_gen/1"}, result])
        with patch.object(module, "expand_caption", return_value="Full-color photograph of a blue cat.") as expand, \
                patch.object(module.native.Provider, "start") as start:
            response = self.provider.generate({"model": "flux-3-image-klein", "prompt": "青い猫", "width": 1201, "height": 777, "format": "png"})
            expand.assert_called_once_with(self.root / "pup", "青い猫", 1201, 777)
            start.assert_called_once()
        payload = self.provider.request.call_args_list[0].args[1]
        self.assertEqual(payload["prompt"], "Full-color photograph of a blue cat.")
        self.assertEqual((payload["width"], payload["height"]), (1216, 784))
        self.assertEqual(payload["sample_params"], {"sample_method": "euler", "sample_steps": 16, "guidance": {"txt_cfg": 1.0}})
        artifact = response["artifact"]
        self.assertEqual((artifact["model"], artifact["modelRevision"], artifact["steps"]),
            ("leejet/flux-3-image-klein-GGUF", "a" * 40, 16))
        path = next(self.root.rglob("metadata.json"))
        with Image.open(path.with_name("image.png")) as image:
            self.assertEqual(image.size, (1201, 777))
        self.assertNotIn("青い猫", path.read_text())
        self.assertNotIn("Full-color", path.read_text())

    def test_caption_failure_never_submits_a_job_and_releases_lock(self):
        self.provider.request = Mock()
        with patch.object(module, "expand_caption", side_effect=RuntimeError("caption failed")):
            with self.assertRaisesRegex(RuntimeError, "caption failed"):
                self.provider.generate({"prompt": "A cat"})
        self.provider.request.assert_not_called()
        self.assertFalse(self.provider.generation_lock.locked())
        self.assertEqual(list(self.root.rglob("metadata.json")), [])

    @patch.object(module.native, "available_bytes", return_value=64 * 1024**3)
    @patch.object(module.subprocess, "Popen")
    def test_caption_process_finishes_before_return_and_invalid_output_fails(self, popen, _available):
        child = popen.return_value
        child.communicate.return_value = (json.dumps({"caption": "A detailed caption."}).encode(), None)
        child.returncode = 0
        child.poll.return_value = 0
        self.assertEqual(module.expand_caption(self.root, "A cat", 512, 512), "A detailed caption.")
        child.communicate.return_value = (b'{"caption":""}', None)
        with self.assertRaisesRegex(RuntimeError, "invalid caption"):
            module.expand_caption(self.root, "A cat", 512, 512)

    @patch.object(module.native, "available_bytes", return_value=15 * 1024**3)
    @patch.object(module.subprocess, "Popen")
    def test_caption_memory_floor_terminates_its_process(self, popen, _available):
        child = popen.return_value
        child.poll.return_value = None
        with self.assertRaisesRegex(RuntimeError, "memory floor"):
            module.expand_caption(self.root, "A cat", 512, 512)
        child.terminate.assert_called_once()

    @patch.object(module.native, "available_bytes", return_value=64 * 1024**3)
    @patch.object(module.subprocess, "Popen")
    def test_caption_timeout_kills_a_process_that_ignores_termination(self, popen, _available):
        child = popen.return_value
        child.poll.return_value = None
        child.communicate.side_effect = [subprocess.TimeoutExpired("caption", 5), (b"", None)]
        with patch.object(module.time, "monotonic", side_effect=[0, 181]):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                module.expand_caption(self.root, "A cat", 512, 512)
        child.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
