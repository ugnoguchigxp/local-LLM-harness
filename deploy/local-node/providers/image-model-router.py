"""Select an image model inside the existing demand-only image service."""
import importlib.util
import json
import threading
from pathlib import Path


class ImageModelUnavailableError(RuntimeError):
    code = "image_model_unavailable"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImageModelRouter:
    model_name = "image-model-router"

    def __init__(self, qwen, config: Path, engine_port: int):
        self.qwen = qwen
        self.config_path = config
        self.engine_port = engine_port
        self.flux = load_module("larm_flux_image", Path(__file__).with_name("flux3-image-provider.py"))
        self.prepare = load_module("larm_flux_prepare", Path(__file__).parents[1] / "scripts/prepare-flux3-image-runtime.py")
        self.flux_provider = None
        self.generation_lock = threading.Lock()
        self.selected = None
        self.accepting = False

    def get_flux_provider(self):
        if self.flux_provider is None:
            # Optional assets must never prevent an independent Qwen request.
            # Resolve them only after selecting FLUX, under the generation lock.
            try:
                config = json.loads(self.config_path.read_text())
                if not isinstance(config, dict) or set(config) != {"flux-3-image-klein"}:
                    raise ValueError("image model configuration must explicitly select FLUX 3 Klein")
                manifest = config["flux-3-image-klein"]
                self.prepare.prepare(manifest)
                self.flux_provider = self.flux.Provider(
                    self.flux.engine_command(*(Path(manifest[name]) for name in ("engine", "model", "encoder", "vae")), self.engine_port),
                    f"http://127.0.0.1:{self.engine_port}", self.qwen.artifact_root,
                    manifest["modelSource"], manifest["modelRevision"], Path(manifest["upsampler"]))
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise ImageModelUnavailableError("FLUX runtime assets are not configured or unavailable") from error
        return self.flux_provider

    def start(self):
        # Readiness is acceptance, with no image model or caption model started.
        self.accepting = True

    def ready(self):
        return self.accepting

    def close(self):
        self.accepting = False
        if self.selected is not None:
            self.selected.close()

    def generate(self, request):
        name = request.get("model", "qwen-image-2.1-turbo")
        if name not in ("qwen-image-2.1-turbo", "flux-3-image-klein"):
            raise ValueError("unknown image model")
        if not self.generation_lock.acquire(blocking=False):
            raise RuntimeError("image provider is busy")
        try:
            if not self.accepting:
                raise RuntimeError("image worker accepts only one generation before shutdown")
            provider = self.get_flux_provider() if name == "flux-3-image-klein" else self.qwen
            provider.validate_request(request)
            self.accepting = False
            self.selected = provider
            reserve = 48 if name == "flux-3-image-klein" else 34
            if self.flux.native.available_bytes() < (reserve + 16) * 1024**3:
                raise RuntimeError("insufficient available memory for selected image model")
            provider.start()
            return provider.generate(request)
        finally:
            try:
                self.close()
            finally:
                self.generation_lock.release()
