"""Existing image service must start only the requested backend and clean it up."""
import importlib.util
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("image_router", Path(__file__).with_name("image-model-router.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImageRouterTest(unittest.TestCase):
    def router(self):
        router = module.ImageModelRouter.__new__(module.ImageModelRouter)
        router.qwen, router.flux_provider = Mock(), Mock()
        router.flux = SimpleNamespace(native=SimpleNamespace(available_bytes=lambda: 90 * 1024**3))
        router.generation_lock = threading.Lock()
        router.selected, router.accepting = None, False
        return router

    def test_only_selected_model_starts_and_closes_before_success(self):
        for model in (None, "qwen-image-2.1-turbo", "flux-3-image-klein"):
            with self.subTest(model=model):
                router = self.router()
                request = {"prompt": "A cat", **({"model": model} if model else {})}
                selected = router.flux_provider if model == "flux-3-image-klein" else router.qwen
                other = router.qwen if model == "flux-3-image-klein" else router.flux_provider
                selected.generate.return_value = {"status": "succeeded"}
                router.start()
                self.assertTrue(router.ready())
                selected.start.assert_not_called()
                self.assertEqual(router.generate(request), {"status": "succeeded"})
                selected.validate_request.assert_called_once_with(request)
                selected.start.assert_called_once()
                selected.close.assert_called_once()
                other.start.assert_not_called()
                self.assertFalse(router.ready())
                self.assertFalse(router.generation_lock.locked())
                with self.assertRaisesRegex(RuntimeError, "one generation"):
                    router.generate(request)
                self.assertEqual(selected.generate.call_count, 1)

    def test_invalid_request_never_starts_any_backend(self):
        router = self.router()
        router.start()
        router.flux_provider.validate_request.side_effect = ValueError("FLUX requires sixteen steps")
        with self.assertRaises(ValueError):
            router.generate({"model": "flux-3-image-klein", "prompt": "A cat", "steps": 8})
        with self.assertRaises(ValueError):
            router.generate({"model": "unknown", "prompt": "A cat"})
        router.qwen.start.assert_not_called()
        router.flux_provider.start.assert_not_called()

    def test_failed_flux_never_falls_back_and_releases_its_lock(self):
        router = self.router()
        router.start()
        router.flux_provider.generate.side_effect = RuntimeError("caption failed")
        with self.assertRaisesRegex(RuntimeError, "caption failed"):
            router.generate({"model": "flux-3-image-klein", "prompt": "A cat"})
        router.flux_provider.close.assert_called_once()
        router.qwen.start.assert_not_called()
        self.assertFalse(router.generation_lock.locked())

    def test_selected_memory_reserve_prevents_launch(self):
        router = self.router()
        router.start()
        router.flux.native.available_bytes = lambda: 60 * 1024**3
        with self.assertRaisesRegex(RuntimeError, "insufficient"):
            router.generate({"model": "flux-3-image-klein", "prompt": "A cat"})
        router.flux_provider.start.assert_not_called()
        router.qwen.start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
