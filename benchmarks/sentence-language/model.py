"""Frozen sentence encoder plus a separately trained Japanese/English head."""
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

PUBLIC_MODEL = 'ruri-v3-30m-sentence-language-prototype'
REVISION = '24899e5de370b56d179604a007c0d727bf144504'
LABELS = ['ja', 'en']
PREFIX = 'トピック: '


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class SentenceEncoder:
    def __init__(self, graph, tokenizer, graph_hash, tokenizer_hash):
        started = time.perf_counter()
        if sha256(graph) != graph_hash or sha256(tokenizer) != tokenizer_hash:
            raise ValueError('encoder artifact hash mismatch')
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.no_truncation()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(graph), options, providers=['CPUExecutionProvider'])
        self.session.disable_fallback()
        if self.session.get_providers() != ['CPUExecutionProvider']:
            raise ValueError('unexpected execution provider')
        self.load_ms = (time.perf_counter() - started) * 1000

    def encode(self, text):
        if not isinstance(text, str) or not text.strip():
            raise ValueError('nonempty sentence required')
        encoded = self.tokenizer.encode(PREFIX + text)
        if len(encoded.ids) > 512:
            raise ValueError('input_limit: sentence exceeds 512 tokens; no truncation')
        feed = {'input_ids': np.asarray([encoded.ids], dtype=np.int64),
                'attention_mask': np.asarray([encoded.attention_mask], dtype=np.int64)}
        vector = self.session.run(None, feed)[0][0].astype(np.float32)
        if vector.shape != (256,) or not np.isfinite(vector).all():
            raise ValueError('invalid sentence embedding')
        return vector, len(encoded.ids)


def predict_vectors(head, vectors):
    weights = np.asarray(head['weights'], dtype=np.float64)
    bias = float(head['bias'])
    temperature = float(head['temperature'])
    if weights.shape != (256,) or not np.isfinite(weights).all() or not np.isfinite(bias):
        raise ValueError('invalid binary head')
    if not np.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid calibration temperature')
    logits = np.asarray(vectors, dtype=np.float64) @ weights + bias
    calibrated = logits / temperature
    # Stable sigmoid, including extreme logits.
    probabilities_en = np.exp(-np.logaddexp(0, -calibrated))
    return (logits > 0).astype(np.int64), probabilities_en


class SentenceLanguageModel:
    def __init__(self, directory):
        root = Path(directory)
        self.head = json.loads((root / 'head.json').read_text())
        manifest = json.loads((root / 'manifest.json').read_text())
        if sha256(root / 'head.json') != manifest['head_sha256']:
            raise ValueError('head hash mismatch')
        if (self.head['model'] != PUBLIC_MODEL or self.head['encoder_revision'] != REVISION
                or self.head['labels'] != LABELS or not self.head['encoder_frozen']
                or self.head['evaluation_labels_used']):
            raise ValueError('head provenance mismatch')
        self.encoder = SentenceEncoder(manifest['graph_path'], manifest['tokenizer_path'],
                                       manifest['graph_sha256'], manifest['tokenizer_sha256'])

    def predict(self, text):
        started = time.perf_counter()
        vector, tokens = self.encoder.encode(text)
        prediction, p_en = predict_vectors(self.head, vector[None, :])
        index = int(prediction[0])
        probabilities = {'ja': float(1 - p_en[0]), 'en': float(p_en[0])}
        return dict(model=PUBLIC_MODEL, language=LABELS[index], confidence=probabilities[LABELS[index]],
                    probabilities=probabilities, input_tokens=tokens,
                    inference_ms=(time.perf_counter() - started) * 1000,
                    encoder_revision=REVISION, head_revision=self.head['head_revision'])
