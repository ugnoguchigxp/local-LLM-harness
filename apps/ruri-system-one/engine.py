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
import language


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
    def __init__(self, root, language_root=None):
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
        language_started = time.perf_counter()
        self.language_manifest = json.loads(Path(__file__).with_name('language-assets.json').read_text())
        lm = self.language_manifest
        shared = {entry['path']: entry['sha256'] for entry in self.manifest['files']}
        if (lm['revision'] != self.manifest['revision'] or lm['encoder_sha256'] != shared['model.onnx']
                or lm['tokenizer_sha256'] != shared['tokenizer.json']):
            raise ValueError('language head requires the same pinned encoder and tokenizer')
        language_root = Path(language_root) if language_root else root.parent / 'ruri-sentence-language-v1'
        verify_assets(language_root, lm)
        language_head = json.loads((language_root / 'head.json').read_text())
        if (language_head['model'] != language.TRAINING_MODEL or language_head['encoder_revision'] != lm['revision']
                or language_head['labels'] != list(language.LABELS) or not language_head['encoder_frozen']
                or language_head['evaluation_labels_used'] or language_head['runtime_precision'] != 'int8'
                or language_head['input_prefix'] != language.PREFIX or language_head['head_revision'] != lm['head_revision']
                or language_head['data_sha256'] != lm['training_data_sha256']
                or len(language_head['train_ids']) != 400 or len(set(language_head['train_ids'])) != 400
                or len(language_head['calibration_ids']) != 40):
            raise ValueError('sentence-language head provenance mismatch')
        self.language_weights = np.asarray(language_head['weights'], dtype=np.float64)
        self.language_bias = float(language_head['bias'])
        self.language_temperature = float(language_head['temperature'])
        if (self.language_weights.shape != (256,) or not np.isfinite(self.language_weights).all()
                or not np.isfinite(self.language_bias) or not np.isfinite(self.language_temperature)
                or self.language_temperature <= 0):
            raise ValueError('invalid sentence-language head values')
        self.language_load_ms = (time.perf_counter() - language_started) * 1000
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
        for text in ['これは日本語の文章です。', 'This sentence is written in English.']:
            self.infer_language(text)
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
        if isinstance(body, dict) and body.get('model') == language.PUBLIC_MODEL:
            return self.predict_language(body)
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

    def infer_language(self, text):
        started = time.perf_counter()
        with self.lock:
            queue_ms = (time.perf_counter() - started) * 1000
            encoded = self.full_tokenizer.encode(language.PREFIX + text)
            if len(encoded.ids) > 512:
                raise ValueError('sentence-language input exceeds 512 tokens; no truncation')
            feed = {'input_ids': np.asarray([encoded.ids], dtype=np.int64),
                    'attention_mask': np.asarray([encoded.attention_mask], dtype=np.int64)}
            vector = self.session.run(None, feed)[0][0].astype(np.float64)
            logit = float(self.language_weights @ vector + self.language_bias)
            return logit, len(encoded.ids), queue_ms

    def predict_language(self, body):
        text, questions = language.validate_request(body)
        started = time.perf_counter()
        logit, tokens, queue_ms = self.infer_language(text)
        answer = language.choice_answer(logit, self.language_temperature)
        return {'model': language.PUBLIC_MODEL,
                'answers': {key: dict(answer) for key in questions},
                'usage': {'input_tokens': tokens, 'output_tokens': 0},
                'truncated': False, 'state_tokens_dropped': 0,
                'routing': {'model': language.PUBLIC_MODEL, 'revision': self.language_manifest['revision'],
                            'head_revision': self.language_manifest['head_revision'],
                            'calibration_revision': 'embedded-in-head-' + self.language_manifest['files'][0]['sha256'][:12],
                            'input_mode': 'sentence', 'method': 'frozen_encoder_trained_head',
                            'precision': 'dynamic-int8-encoder-fp64-head', 'preliminary': True,
                            'execution_providers': self.session.get_providers(), 'threads': 4,
                            'encoder_shared': True, 'encoder_session_count': 1,
                            'queue_ms': queue_ms, 'inference_ms': (time.perf_counter() - started) * 1000}}

    def health(self):
        return {'status': 'ok', 'model': PUBLIC_MODEL, 'revision': self.manifest['revision'],
                'head_revision': self.manifest['head_revision'],
                'calibration_revision': self.manifest['calibration_revision'], 'input_mode': 'A',
                'execution_providers': self.session.get_providers(), 'threads': 4, 'batch': 1,
                'max_tokens': 512, 'load_ms': self.load_ms, 'input_cache': False,
                'candidate_cache': False, 'preliminary': True, 'labels': list(LABELS),
                'models': [PUBLIC_MODEL, language.PUBLIC_MODEL], 'encoder_session_count': 1,
                'sentence_language': {'model': language.PUBLIC_MODEL,
                                      'head_revision': self.language_manifest['head_revision'],
                                      'labels': list(language.LABELS), 'head_load_ms': self.language_load_ms,
                                      'encoder_shared': True, 'max_tokens': 512, 'truncation': 'reject'},
                'onnxruntime': ort.__version__, 'temperature': self.temperature}
