"""Malformed optional assets must fail validation before starting any model."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_flux", Path(__file__).with_name("prepare-flux3-image-runtime.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareFluxTest(unittest.TestCase):
    def manifest(self):
        return {**{key: f"/srv/ai/models/test/{key}" for key in ("engine", "model", "encoder", "vae", "upsampler")},
            "modelSource": "leejet/flux-3-image-klein-GGUF", **{key: "a" * 40
                for key in ("modelRevision", "engineRevision", "upsamplerRevision")}}

    def prepare_with_index(self, index):
        def read(path):
            return json.dumps({"t2i": "official prompt"} if path.name == "system_prompts.json" else index)
        with patch.object(Path, "is_file", return_value=True), patch.object(Path, "is_dir", return_value=True), \
                patch.object(module.os, "access", return_value=True), patch.object(Path, "read_text", read):
            return module.prepare(self.manifest())

    def test_malformed_manifest_types_are_validation_errors(self):
        for manifest in (None, [], ["engine"], "engine", {}):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                module.prepare(manifest)

    def test_malformed_or_unsafe_weight_indices_are_validation_errors(self):
        for index in (None, [], {}, {"weight_map": []}, {"weight_map": {}},
                {"weight_map": {"tensor": []}}, {"weight_map": {"tensor": "../outside.safetensors"}},
                {"weight_map": {"tensor": "/outside.safetensors"}}):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.prepare_with_index(index)

    def test_valid_sharded_model_can_be_prepared_without_inference(self):
        result = self.prepare_with_index({"weight_map": {"a": "part-1.safetensors", "b": "part-1.safetensors"}})
        self.assertIn("LARM_FLUX3_MODEL_SOURCE=leejet/flux-3-image-klein-GGUF\n", result)


if __name__ == "__main__":
    unittest.main()
