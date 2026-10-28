"""Demand-started image description service with an isolated CPU llama.cpp child."""
import base64, io, json, os, socket, subprocess, threading, time, urllib.request
from contract import MODEL, REVISION, Rejected, validate_request
from imaging import decode_image
from handler import Handler, Server

class Worker:
    def __init__(self, url):
        self.url, self.lock = url, threading.Lock()

    def perceive(self, value):
        if not self.lock.acquire(blocking=False):
            raise Rejected('provider_busy', 429)
        try:
            started = time.perf_counter()
            request, raw, media = validate_request(value)
            img = decode_image(raw, media)
            output = io.BytesIO()
            img.save(output, format='PNG')
            uri = 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii')
            decoded = time.perf_counter()
            payload = {'model': MODEL, 'messages': [{'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': uri}}, {'type': 'text', 'text': request['query']}]}],
                'temperature': 0, 'max_tokens': request['maxNewTokens'], 'cache_prompt': False,
                'chat_template_kwargs': {'enable_thinking': False}}
            upstream = urllib.request.Request(self.url + '/v1/chat/completions', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(upstream, timeout=150) as res:
                result = json.load(res)
            end = time.perf_counter()
            choice = result['choices'][0]
            content = choice['message']['content']
            if not isinstance(content, str) or len(content) > 65536:
                raise Rejected('invalid_model_response', 502)
            timings = result.get('timings', {})
            return {'contractVersion': 'larm.visual-perception.v1', 'model': MODEL, 'modelRevision': REVISION,
                'task': 'describe', 'image': {'width': img.width, 'height': img.height, 'orientation': 'exif-normalized'},
                'response': content, 'detections': [], 'masks': [], 'truncated': choice.get('finish_reason') == 'length',
                'timings': {'imageDecodeMs': (decoded-started)*1000, 'preprocessMs': float(timings.get('prompt_ms', 0)),
                    'generationMs': float(timings.get('predicted_ms', 0)), 'maskMs': 0, 'postprocessMs': 0, 'totalMs': (end-started)*1000},
                'execution': {'device': 'cpu', 'backend': 'llama.cpp', 'dtype': 'qad-q4_0',
                    'outputTokens': result['usage']['completion_tokens'], 'inputTokens': result['usage']['prompt_tokens']}}
        finally:
            self.lock.release()

def main():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    cmd = ['/srv/ai/apps/larm-lfm3-vl-19cce69-v1/llama-server', '-m', '/srv/ai/models/lfm3-vl-2b-gguf/LFM3-VL-2B-QAD-Q4_0.gguf',
        '--mmproj', '/srv/ai/models/lfm3-vl-2b-gguf/mmproj-LFM3-VL-2B-F16.gguf', '--alias', MODEL,
        '-dev', 'none', '-ngl', '0', '--no-mmproj-offload', '-c', '8192', '-np', '1', '-b', '512', '-ub', '256', '-t', '8',
        '--host', '127.0.0.1', '--port', str(port), '--jinja', '--no-cache-prompt', '--no-webui', '--log-disable']
    child = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if child.poll() is not None: raise RuntimeError('llama server exited during startup')
            try:
                with urllib.request.urlopen(url + '/health', timeout=1) as response:
                    if response.status == 200: break
            except Exception: time.sleep(.25)
        else: raise RuntimeError('llama server did not start')
        Handler.worker = Worker(url)
        Server(('127.0.0.1', int(os.environ.get('LFM_VISION_PORT', '8095'))), Handler).serve_forever()
    finally:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()

if __name__ == '__main__': main()
