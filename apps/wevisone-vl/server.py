"""One offline ROCm worker, owned and stopped by LARM's systemd lifecycle."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from contract import MODEL, REVISION, SOURCE_REVISION, Rejected, validate_request


def load_engine():
    source = Path(os.environ["WEVISONE_SOURCE"])
    model = Path(os.environ["WEVISONE_MODEL"])
    receipt = json.loads(Path(__file__).with_name("model-receipt.json").read_text())
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip()
    if revision != SOURCE_REVISION or dirty or receipt["revision"] != REVISION or model.resolve() != Path(receipt["directory"]).resolve():
        raise RuntimeError("pinned model/source identity mismatch")
    for item in receipt["files"]:
        path = model / item["path"]
        if path.is_symlink() or path.stat().st_size != item["bytes"]:
            raise RuntimeError("model file identity mismatch")
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                raise RuntimeError("model checksum mismatch")
    sys.path.insert(0, str(source))
    import torch
    from wevisone_vl import WeVisOneVL
    if not torch.cuda.is_available() or not torch.version.hip or not torch.cuda.get_device_properties(0).gcnArchName.startswith("gfx1151"):
        raise RuntimeError("gfx1151 ROCm GPU required; CPU fallback is forbidden")
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    engine = WeVisOneVL(str(model), backend="transformers", device="cuda:0", dtype="bfloat16",
                       attention_implementation="sdpa", max_pixels=1960 * 32 * 32, decoder_batch_size=1)
    parameter = next(engine.model.parameters())
    if parameter.device.type != "cuda" or parameter.dtype != torch.bfloat16:
        raise RuntimeError("unexpected backbone placement/precision")
    return engine, torch


class Worker:
    def __init__(self, engine, torch):
        self.engine, self.torch = engine, torch
        self.lock = threading.Lock()
        self.metrics = {}
        original_inputs, original_generate, original_masks = engine._inputs, engine.model.generate, engine.decode_masks

        def inputs(*args, **kwargs):
            self.torch.cuda.synchronize()
            start = time.perf_counter()
            value = original_inputs(*args, **kwargs)
            self.torch.cuda.synchronize()
            if kwargs.get("generation"):
                self.metrics["preprocessMs"] = (time.perf_counter() - start) * 1000
                self.metrics["visualTokens"] = int(value["image_grid_thw"].prod().item() // (engine.spatial_merge_size ** 2))
            return value

        def generate(*args, **kwargs):
            self.torch.cuda.synchronize()
            start = time.perf_counter()
            value = original_generate(*args, **kwargs, max_time=120)
            self.torch.cuda.synchronize()
            self.metrics["generationMs"] = (time.perf_counter() - start) * 1000
            self.metrics["outputTokens"] = int(value.shape[1] - kwargs["input_ids"].shape[1])
            self.metrics["generationTimedOut"] = time.perf_counter() - start >= 120
            return value

        def masks(*args, **kwargs):
            from wevisone_vl.engine import parse_seg_boxes
            if len(parse_seg_boxes(args[2])) > 8:
                raise Rejected("too_many_masks", 413)
            self.torch.cuda.synchronize()
            start = time.perf_counter()
            value = original_masks(*args, **kwargs)
            self.torch.cuda.synchronize()
            self.metrics["maskMs"] = (time.perf_counter() - start) * 1000
            return value

        engine._inputs, engine.model.generate, engine.decode_masks = inputs, generate, masks

    def perceive(self, value):
        from imaging import decode_image, export_result
        if not self.lock.acquire(blocking=False):
            raise Rejected("provider_busy", 429)
        # The GPU call cannot safely be cancelled by abandoning its Python thread.
        # A hard deadline exits this dedicated worker and releases its GPU memory.
        watchdog = threading.Timer(180, lambda: os._exit(124))
        watchdog.daemon = True
        watchdog.start()
        try:
            start = time.perf_counter()
            request, raw, media_type = validate_request(value)
            image = decode_image(raw, media_type)
            decoded = time.perf_counter()
            self.metrics = {"preprocessMs": 0, "generationMs": 0, "maskMs": 0, "outputTokens": 0, "visualTokens": 0}
            result = self.engine.predict(image, task="freeform" if request["task"] == "describe" else request["task"],
                                         query=request["query"], max_new_tokens=request["maxNewTokens"], temperature=0.0,
                                         decode_matting=request["task"] in {"segmentation", "matting"})
            self.torch.cuda.synchronize()
            if self.metrics.get("generationTimedOut"):
                raise Rejected("generation_timeout", 504)
            post = time.perf_counter()
            detections, masks = export_result(result, request["task"], image)
            finished = time.perf_counter()
            response = {"contractVersion": "larm.visual-perception.v1", "model": MODEL, "modelRevision": REVISION,
                        "task": request["task"], "image": {"width": image.width, "height": image.height, "orientation": "exif-normalized"},
                        "response": result.response, "detections": detections, "masks": masks,
                        "truncated": self.metrics["outputTokens"] >= request["maxNewTokens"],
                        "timings": {"imageDecodeMs": (decoded-start)*1000, "preprocessMs": self.metrics["preprocessMs"],
                                    "generationMs": self.metrics["generationMs"], "maskMs": self.metrics["maskMs"],
                                    "postprocessMs": (finished-post)*1000, "totalMs": (finished-start)*1000},
                        "execution": {"device": "cuda:0", "backend": "transformers", "dtype": "bfloat16", "decoderDtype": "float32",
                                      "outputTokens": self.metrics["outputTokens"], "visualTokens": self.metrics["visualTokens"]}}
            if request["task"] == "count_box" and not response["truncated"]:
                response["count"] = len(detections)
            return response
        finally:
            watchdog.cancel()
            self.lock.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    worker = None

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass  # Request/image contents never enter the journal.

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok", "model": MODEL, "device": "cuda:0", "dtype": "bfloat16", "busy": self.worker.lock.locked()})
        else:
            self.reply(404, {"error": {"code": "not_found"}})

    def do_POST(self):
        if self.path != "/v1/vision/perceive":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or len(lengths[0]) > 8 or not lengths[0].isdigit():
                raise Rejected("content_length_required", 411)
            size = int(lengths[0])
            if not 0 < size <= 8 * 1024 * 1024:
                raise Rejected("request_too_large", 413)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise Rejected("json_required", 415)
            data = self.rfile.read(size)
            if len(data) != size:
                raise Rejected("incomplete_request")
            try:
                value = json.loads(data.decode("utf-8"))
            except (ValueError, UnicodeError) as error:
                raise Rejected("invalid_json") from error
            self.reply(200, self.worker.perceive(value))
        except Rejected as error:
            self.reply(error.status, {"error": {"code": error.code, "message": error.code}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            # Fail closed on GPU/runtime errors. A subsequent LARM demand starts a fresh worker.
            try:
                self.reply(503, {"error": {"code": "worker_failed", "message": "worker_failed"}})
            finally:
                os._exit(1)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 4

    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(6)
        super().__init__(*args)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    engine, torch = load_engine()
    Handler.worker = Worker(engine, torch)
    Server(("127.0.0.1", int(os.environ.get("WEVISONE_PORT", "8094"))), Handler).serve_forever()
