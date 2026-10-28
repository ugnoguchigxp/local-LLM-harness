"""Local-only, pinned d1-2B inference; weights and upstream model code stay external."""
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import threading
import time

from contract import (IMAGE, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS,
                      MAX_INPUT_TOKENS, PUBLIC_MODEL, REVISION, adapt_response, validate_request)


def verify_assets(root):
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
    if manifest['revision'] != REVISION:
        raise ValueError('unexpected d1 model revision')
    for entry in manifest['files']:
        path = root / entry['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes']:
            raise ValueError('missing or invalid d1 artifact: ' + entry['path'])
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                raise ValueError('d1 artifact checksum mismatch: ' + entry['path'])


def decode_images(urls):
    from PIL import Image, UnidentifiedImageError
    pictures = []
    for url in urls:
        match = IMAGE.fullmatch(url)
        try:
            data = base64.b64decode(match[2], validate=True)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError('image exceeds byte limit')
            with Image.open(BytesIO(data)) as source:
                if source.format not in ('PNG', 'JPEG', 'WEBP') or source.width * source.height > MAX_IMAGE_PIXELS:
                    raise ValueError('image exceeds the supported format or pixel limit')
                source.load()
                image = source.convert('RGB')
                image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.BICUBIC)
                pictures.append(image)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise ValueError('invalid image data') from error
    return pictures


class Engine:
    def __init__(self, root, device='cuda'):
        import torch
        from transformers import AutoModel
        started = time.perf_counter()
        root = Path(root)
        if root.is_symlink():
            raise ValueError('model root must be a real local directory')
        verify_assets(root)
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        if device not in ('cuda', 'cpu') or (device == 'cuda' and not torch.cuda.is_available()):
            raise RuntimeError('the explicitly selected d1 execution device is unavailable')
        self.device = device
        self.precision = 'bfloat16' if device == 'cuda' else 'float32'
        self.model = AutoModel.from_pretrained(str(root), trust_remote_code=True, local_files_only=True,
            dtype=torch.bfloat16 if device == 'cuda' else torch.float32, attn_implementation='sdpa').to(device).eval()
        self.runner = self.model.engine
        self.runner.token_budget = MAX_INPUT_TOKENS
        self.tree_attention = 'native'
        if device == 'cuda' and torch.version.hip:
            # ROCm's packed flash-attention LSE layout differs from the CUDA
            # layout assumed upstream. Keep upstream's mathematically equivalent
            # explicit GPU tree path; the weights and model files stay untouched.
            from importlib import import_module
            package = self.runner.__class__.__module__.rsplit('.', 1)[0]
            import_module(package + '.attention')._fused = lambda queries: False
            self.tree_attention = 'explicit-fp32-rocm'
        self.lock = threading.Lock()
        self.torch_version = torch.__version__
        self.hip_version = torch.version.hip
        self.device_name = torch.cuda.get_device_name(0) if device == 'cuda' else 'CPU'
        warmup = {'model': PUBLIC_MODEL, 'state': {'player_x': 1, 'target_x': 3},
                  'questions': {'action': {'type': 'choice', 'instructions': 'Move toward target_x. Right increases x; left decreases x.',
                                          'criteria': {'left': 'Move left', 'right': 'Move right', 'wait': 'Do not move'}}}}
        for _ in range(3):
            self.predict(warmup)
        from PIL import Image
        image = BytesIO()
        Image.new('RGB', (384, 384), (255, 0, 0)).save(image, format='PNG')
        visual_warmup = {'model': PUBLIC_MODEL, 'state': None,
            'images': ['data:image/png;base64,' + base64.b64encode(image.getvalue()).decode('ascii')],
            'questions': {'color': {'type': 'choice', 'instructions': 'What is the dominant color?',
                                     'criteria': {'red': 'Red', 'blue': 'Blue'}}}}
        for _ in range(2):
            self.predict(visual_warmup)
        self.load_ms = (time.perf_counter() - started) * 1000

    def predict(self, body):
        state, questions, urls = validate_request(body)
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError('d1 is processing another request')
        try:
            started = time.perf_counter()
            pictures = decode_images(urls)
            # Count the actual packed prompt, including all questions and image tokens.
            typed = list(self.runner.named(questions).values())
            sequences = self.runner._sequences([(state, typed, pictures)])
            if sum(len(sequence[2]) for sequence in sequences) > MAX_INPUT_TOKENS:
                raise ValueError('d1 input exceeds 4096-token budget; no truncation')
            result = adapt_response(self.model.system_one(state, questions, media=pictures), questions)
            result['routing'] = {'model': PUBLIC_MODEL, 'revision': REVISION, 'device': self.device,
                                 'precision': self.precision, 'method': 'single_forward_decision',
                                 'tree_attention': self.tree_attention,
                                 'max_input_tokens': MAX_INPUT_TOKENS, 'max_image_edge': MAX_IMAGE_EDGE,
                                 'inference_ms': (time.perf_counter() - started) * 1000}
            return result
        finally:
            self.lock.release()

    def health(self):
        return {'status': 'ok', 'model': PUBLIC_MODEL, 'models': [PUBLIC_MODEL], 'revision': REVISION,
                'device': self.device, 'device_name': self.device_name, 'precision': self.precision,
                'torch': self.torch_version, 'hip': self.hip_version, 'compile': False,
                'tree_attention': self.tree_attention,
                'load_ms': self.load_ms, 'max_input_tokens': MAX_INPUT_TOKENS, 'max_questions': 16,
                'max_images': 1, 'max_image_edge': MAX_IMAGE_EDGE, 'active_requests': int(self.lock.locked()),
                'queue_depth': 0}
