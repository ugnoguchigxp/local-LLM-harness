"""Frozen Ruri intent head: explicit two-turn input, independent of attitude."""
import hashlib
import json
from pathlib import Path
import re
import unicodedata

LABELS = ['request', 'chat', 'followup', 'noise', 'incomplete']
PUBLIC_MODEL = 'ruri-v3-30m-user-intent-v1'
INSTRUCTION = '直前のエージェント発言を参考に、最新のユーザー発言の意図を分類する。'
ROOT = Path(__file__).resolve().parents[2]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def external(path):
    path = Path(path).resolve()
    if path == ROOT or ROOT in path.parents:
        raise ValueError('data and model outputs must be outside the source repository')
    return path


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def normalized(text):
    return re.sub(r'[\s。、！？!?]', '', unicodedata.normalize('NFKC', text)).casefold()


def surface_features(text):
    """Fixed signed character hashing, including word-fragment end markers.

    No vocabulary, label or corpus frequency is learned from evaluation data.
    """
    import numpy as np
    text = '^' + re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).casefold() + '$'
    vector = np.zeros(4096, dtype=np.float32)
    for n in range(1, 5):
        for i in range(len(text)-n+1):
            digest = hashlib.blake2b(text[i:i+n].encode(), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], 'little') % 4096
            vector[bucket] += 1. if digest[4] & 1 else -1.
    vector = np.sign(vector) * np.log1p(np.abs(vector))
    norm = np.linalg.norm(vector)
    return vector / norm if norm else vector


def format_input(row, tokenizer):
    """Keep the first 160 history tokens; latest text remains the target.

    The completed input is right-truncated at 512 by the inference tokenizer.
    Metadata, notes, labels and toolchain never enter the encoder.
    """
    text = row['text']
    previous = row.get('previous_agent')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('text must be nonempty')
    if previous is not None and (not isinstance(previous, str) or not previous.strip()):
        raise ValueError('previous_agent must be nonempty or null')
    ids = tokenizer.encode(previous or '', add_special_tokens=False).ids
    history = tokenizer.decode(ids[:160], skip_special_tokens=False) if previous else '（なし）'
    return ('トピック: ' + INSTRUCTION + '\n[直前のエージェント発言]\n' + history
            + '\n[/直前のエージェント発言]\n[最新のユーザー発言・判断対象]\n' + text
            + '\n[/最新のユーザー発言・判断対象]'), max(0, len(ids) - 160)


def probabilities(logits, temperature):
    import numpy as np
    logits = np.asarray(logits, dtype=np.float64)
    if not np.isfinite(logits).all() or not np.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid logits or temperature')
    exp = np.exp((logits - logits.max(axis=-1, keepdims=True)) / temperature)
    return exp / exp.sum(axis=-1, keepdims=True)


class Encoder:
    def __init__(self, root, manifest_path):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        root = Path(root)
        self.manifest = json.loads(Path(manifest_path).read_text())
        if self.manifest['model'] != 'cl-nagoya/ruri-v3-30m':
            raise ValueError('requires the pinned Ruri 30m encoder')
        files = {f['path']: f for f in self.manifest['files']}
        self.encoder_hashes = {}
        for name in ('model.onnx', 'tokenizer.json'):
            if (root / name).stat().st_size != files[name]['bytes'] or sha256(root / name) != files[name]['sha256']:
                raise ValueError('encoder artifact mismatch: ' + name)
            self.encoder_hashes[name] = files[name]['sha256']
        self.full_tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.full_tokenizer.no_truncation()
        self.tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512, direction='right')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(root / 'model.onnx'), options, providers=['CPUExecutionProvider'])
        self.session.disable_fallback()
        if self.session.get_providers() != ['CPUExecutionProvider']:
            raise ValueError('CPU-only encoder required')

    def encode_text(self, text):
        import numpy as np
        encoded = self.tokenizer.encode(text)
        full_count = len(self.full_tokenizer.encode(text).ids)
        vector = self.session.run(None, {
            'input_ids': np.asarray([encoded.ids], dtype=np.int64),
            'attention_mask': np.asarray([encoded.attention_mask], dtype=np.int64),
        })[0][0].astype(np.float32)
        if vector.shape != (256,) or not np.isfinite(vector).all():
            raise ValueError('unexpected encoder output')
        return vector, dict(input_tokens=len(encoded.ids), input_tokens_dropped=max(0, full_count - len(encoded.ids)),
                            history_tokens_dropped=0)

    def encode(self, row, feature_mode='context-only'):
        import numpy as np
        text, history_dropped = format_input(row, self.full_tokenizer)
        if feature_mode == 'current-only':
            return self.encode_text('トピック: ' + row['text'])
        context, usage = self.encode_text(text)
        usage['history_tokens_dropped'] = history_dropped
        if feature_mode == 'context-only':
            return context, usage
        if feature_mode not in ('current-plus-context', 'current-plus-context-charhash'):
            raise ValueError('unknown feature mode')
        current, current_usage = self.encode_text('トピック: ' + row['text'])
        usage.update(current_input_tokens=current_usage['input_tokens'], encoder_calls=2)
        features = [context, current]
        if feature_mode == 'current-plus-context-charhash':
            features.append(surface_features(row['text']))
        return np.concatenate(features), usage


class IntentModel:
    """Offline inference adapter; does not expose or change the running API."""
    def __init__(self, root, encoder_root):
        import numpy as np
        root = Path(root)
        assets = json.loads((root / 'assets.json').read_text())
        for info in assets['files']:
            if sha256(root / info['path']) != info['sha256']:
                raise ValueError('intent artifact mismatch')
        self.head = json.loads((root / 'head.json').read_text())
        self.calibration = json.loads((root / 'calibration.json').read_text())
        if self.head['labels'] != LABELS or self.head['model'] != PUBLIC_MODEL:
            raise ValueError('intent contract mismatch')
        if self.calibration['head_sha256'] != sha256(root / 'head.json'):
            raise ValueError('calibration belongs to a different head')
        self.encoder = Encoder(encoder_root, root / 'encoder-manifest.json')
        if self.head['encoder_hashes'] != self.encoder.encoder_hashes:
            raise ValueError('intent head belongs to a different encoder')
        self.weights = np.asarray(self.head['weights'], dtype=np.float32)
        self.bias = np.asarray(self.head['bias'], dtype=np.float32)
        self.feature_mode = self.head.get('feature_mode', 'context-only')
        dimension = {'context-only':256, 'current-only':256, 'current-plus-context':512,
                     'current-plus-context-charhash':4608}.get(self.feature_mode)
        if dimension is None:
            raise ValueError('unknown feature mode')
        if (self.weights.shape != (5, dimension) or self.bias.shape != (5,)
                or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all()):
            raise ValueError('invalid intent head')
        probabilities([0.] * 5, self.calibration['temperature'])

    def predict(self, text, previous_agent=None):
        vector, usage = self.encoder.encode(dict(text=text, previous_agent=previous_agent), self.feature_mode)
        logits = self.weights @ vector + self.bias
        scores = probabilities(logits, self.calibration['temperature'])
        return dict(model=PUBLIC_MODEL, label=LABELS[int(scores.argmax())],
                    probabilities=dict(zip(LABELS, scores.tolist())), logits=dict(zip(LABELS, logits.tolist())),
                    score_kind='temperature_scaled_classifier_softmax', label_status=self.head['label_status'],
                    usage=usage)
