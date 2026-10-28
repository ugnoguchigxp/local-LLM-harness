import json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contract import MODEL, Rejected

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
            self.reply(200, {"status": "ok", "model": MODEL, "device": "cpu", "dtype": "qad-q4_0", "busy": self.worker.lock.locked()})
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


