"""A later request on the same unit must not invalidate an earlier stop proof."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_image", Path(__file__).with_name("verify-image-model-live.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImageStopProofTest(unittest.TestCase):
    def test_latest_matching_process_before_artifact_creation_belongs_to_request(self):
        def item(pid, model, started):
            return {"native": {"pid": pid}, "modelPath": model, "startedAtEpoch": started}
        observations = [item(1, "Qwen-Image-2.1-Turbo.gguf", 10),
            item(2, "flux3-image-klein-Q8_0.gguf", 20), item(3, "flux3-image-klein-Q8_0.gguf", 31),
            item(4, "Qwen-Image-2.1-Turbo.gguf", 32)]
        own = module.select_request_process(observations, "flux-3-image-klein", "1970-01-01T00:00:30.000Z")
        self.assertEqual(own["native"]["pid"], 2)

    def test_default_model_selects_qwen_process(self):
        observations = [{"native": {"pid": 4}, "modelPath": "Qwen-Image-2.1-Turbo-AD-Q4_K.gguf", "startedAtEpoch": 20}]
        self.assertEqual(module.select_request_process(observations, "default", "1970-01-01T00:00:30Z")["native"]["pid"], 4)

    def test_absent_or_reused_pid_is_stopped_but_same_process_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "123").mkdir()
            fields = ["0"] * 30
            fields[0], fields[1], fields[19] = "S", "10", "456"
            (root / "123/stat").write_text("123 (sd server) " + " ".join(fields))
            self.assertFalse(module.process_stopped({"pid": 123, "startTicks": 456}, root))
            self.assertTrue(module.process_stopped({"pid": 123, "startTicks": 455}, root))
            self.assertTrue(module.process_stopped({"pid": 124, "startTicks": 456}, root))

    def test_missing_evidence_cannot_claim_a_stopped_model(self):
        with self.assertRaisesRegex(RuntimeError, "not observed"):
            module.select_request_process([], "flux-3-image-klein", "1970-01-01T00:00:30Z")


if __name__ == "__main__":
    unittest.main()
