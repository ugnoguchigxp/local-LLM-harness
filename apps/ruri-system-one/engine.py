"""Pinned CPU-only ONNX encoder with a separately trained FP32 linear head."""
import hashlib
import json
from pathlib import Path
import threading
import time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from attitude import LABELS, PUBLIC_MODEL, choice_answer, format_input, validate_request


def verify_assets(root, manifest):
    for file in manifest['files']:
        path = root / file['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != file['bytes']:
            raise ValueError('missing or invalid Ruri artifact: ' + file['path'])
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != file['sha256']:
            raise ValueError('Ruri artifact checksum mismatch: ' + file['path'])


class Engine:
    def __init__(self, root):
        started = time.perf_counter()
        self.manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
        root = Path(root)
        verify_assets(root, self.manifest)
        head = json.loads((root / 'head.json').read_text())
        if (head['revision'] != self.manifest['revision'] or head['labels'] != list(LABELS)
                or not head['encoder_frozen'] or not head['train_only']):
            raise ValueError('Ruri head provenance mismatch')
        calibration = json.loads((root / 'calibration.json').read_text())
        expected_head = next(e['sha256'] for e in self.manifest['files'] if e['path'] == 'head.json')
        if (calibration['head_sha256'] != expected_head or calibration['revision'] != head['revision']
                or calibration['input_mode'] != 'A' or calibration['evaluation_labels_used']
                or calibration['calibration_ids'] != head['calibration_ids']):
            raise ValueError('Ruri calibration provenance mismatch')
        self.temperature = float(calibration['temperature'])
        if not np.isfinite(self.temperature) or self.temperature <= 0:
            raise ValueError('invalid calibration temperature')
        self.weights = np.asarray(head['modes']['A']['weights'], dtype=np.float32)
        self.bias = np.asarray(head['modes']['A']['bias'], dtype=np.float32)
        if self.weights.shape != (6, 256) or self.bias.shape != (6,) or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all():
            raise ValueError('invalid Ruri head shape/values')
        self.tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512, direction='left')
        self.full_tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.full_tokenizer.no_truncation()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(root / 'model.onnx'), options, providers=['CPUExecutionProvider'])
        self.session.disable_fallback()
        if self.session.get_providers() != ['CPUExecutionProvider']:
            raise RuntimeError('unexpected execution provider')
        self.lock = threading.Lock()
        for _ in range(10):
            self.infer('設定画面を開いてください。')
        self.load_ms = (time.perf_counter() - started) * 1000

    def infer(self, text):
        with self.lock:
            encoded = self.tokenizer.encode(format_input(text))
            full_count = len(self.full_tokenizer.encode(format_input(text)).ids)
            feed = {'input_ids': np.asarray([encoded.ids], dtype=np.int64),
                    'attention_mask': np.asarray([encoded.attention_mask], dtype=np.int64)}
            vector = self.session.run(None, feed)[0][0].astype(np.float32)
            return (self.weights @ vector + self.bias).tolist(), len(encoded.ids), max(0, full_count - len(encoded.ids))

    def predict(self, body):
        text, questions = validate_request(body)
        started = time.perf_counter()
        logits, tokens, dropped = self.infer(text)
        return {'model': PUBLIC_MODEL,
                'answers': {key: choice_answer(logits, q['criteria'], self.temperature) for key, q in questions.items()},
                'usage': {'input_tokens': tokens, 'output_tokens': 0},
                'truncated': dropped > 0, 'state_tokens_dropped': dropped,
                'routing': {'model': PUBLIC_MODEL, 'revision': self.manifest['revision'],
                            'head_revision': self.manifest['head_revision'],
                            'calibration_revision': self.manifest['calibration_revision'], 'input_mode': 'A',
                            'method': 'frozen_encoder_trained_head', 'preliminary': True,
                            'precision': 'dynamic-int8-encoder-fp32-head',
                            'execution_providers': self.session.get_providers(), 'threads': 4,
                            'inference_ms': (time.perf_counter() - started) * 1000}}

    def health(self):
        return {'status': 'ok', 'model': PUBLIC_MODEL, 'revision': self.manifest['revision'],
                'head_revision': self.manifest['head_revision'],
                'calibration_revision': self.manifest['calibration_revision'], 'input_mode': 'A',
                'execution_providers': self.session.get_providers(), 'threads': 4, 'batch': 1,
                'max_tokens': 512, 'load_ms': self.load_ms, 'input_cache': False,
                'candidate_cache': False, 'preliminary': True, 'labels': list(LABELS),
                'onnxruntime': ort.__version__, 'temperature': self.temperature}
