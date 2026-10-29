"""Pinned CPU-only ONNX encoder with a separately trained FP32 linear head."""
from pathlib import Path
import threading
import time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from attitude import choice_answer, format_input, validate_request
from artifacts import load_artifacts, verify_assets
import user_intent
from intent_features import format_input as format_intent_input, surface_features


class Engine:
    def __init__(self, root, manifest_path=None, intent_root=None, intent_manifest_path=None):
        started = time.perf_counter()
        root = Path(root)
        self.manifest, head, calibration, self.labels, self.public_model = load_artifacts(root, manifest_path)
        self.contract_version = self.manifest.get('contract', {}).get('version', 'legacy-v1')
        self.calibration_label_status = calibration.get('label_status', 'synthetic-provisional')
        self.temperature = float(calibration['temperature'])
        if not np.isfinite(self.temperature) or self.temperature <= 0:
            raise ValueError('invalid calibration temperature')
        self.weights = np.asarray(head['modes']['A']['weights'], dtype=np.float32)
        self.bias = np.asarray(head['modes']['A']['bias'], dtype=np.float32)
        if self.weights.shape != (len(self.labels), 256) or self.bias.shape != (len(self.labels),) or not np.isfinite(self.weights).all() or not np.isfinite(self.bias).all():
            raise ValueError('invalid Ruri head shape/values')
        self.tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512, direction='left')
        self.full_tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.full_tokenizer.no_truncation()
        self.intent_head = user_intent.load_head(intent_root,self.manifest,intent_manifest_path) if intent_root else None
        self.intent_tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
        self.intent_tokenizer.enable_truncation(max_length=512,direction='right')
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
            if self.intent_head:
                self.infer_intent({'text':'明日の天気を調べて','previous_agent':None})
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
        if isinstance(body,dict) and body.get('model') in ('in','em'):
            model = body['model']
            target = user_intent.PUBLIC_MODEL if model == 'in' else self.public_model
            result = self.predict(dict(body,model=target))
            result['model'] = result['routing']['model'] = model
            return result
        if isinstance(body,dict) and body.get('model') == user_intent.PUBLIC_MODEL:
            if self.intent_head is None:
                raise ValueError('user-intent model is not loaded')
            return self.predict_intent(body)
        text, questions = validate_request(body, self.labels, self.public_model)
        started = time.perf_counter()
        logits, tokens, dropped = self.infer(text)
        return {'model': self.public_model,
                'answers': {key: choice_answer(logits, q['criteria'], self.temperature, self.labels,
                                              self.calibration_label_status) for key, q in questions.items()},
                'usage': {'input_tokens': tokens, 'output_tokens': 0},
                'truncated': dropped > 0, 'state_tokens_dropped': dropped,
                'routing': {'model': self.public_model, 'revision': self.manifest['revision'],
                            'contract_version': self.contract_version,
                            'head_revision': self.manifest['head_revision'],
                            'calibration_revision': self.manifest['calibration_revision'], 'input_mode': 'A',
                            'method': 'frozen_encoder_trained_head', 'preliminary': True,
                            'precision': 'dynamic-int8-encoder-fp32-head',
                            'execution_providers': self.session.get_providers(), 'threads': 4,
                            'inference_ms': (time.perf_counter() - started) * 1000}}

    def health(self):
        return {'status': 'ok', 'model': self.public_model, 'revision': self.manifest['revision'],
                'contract_version': self.contract_version,
                'head_revision': self.manifest['head_revision'],
                'calibration_revision': self.manifest['calibration_revision'], 'input_mode': 'A',
                'execution_providers': self.session.get_providers(), 'threads': 4, 'batch': 1,
                'max_tokens': 512, 'load_ms': self.load_ms, 'input_cache': False,
                'candidate_cache': False, 'preliminary': True, 'labels': list(self.labels),
                'models': [self.public_model, 'em'] + (['in', user_intent.PUBLIC_MODEL] if self.intent_head else []), 'encoder_session_count': 1,
                'user_intent': self.intent_health(),
                'onnxruntime': ort.__version__, 'temperature': self.temperature}

    def infer_intent(self, state):
        with self.lock:
            text, history_dropped = format_intent_input(state,self.full_tokenizer)
            vectors, tokens, dropped = [], 0, 0
            for value in [text,'トピック: '+state['text']]:
                encoded = self.intent_tokenizer.encode(value)
                full_count = len(self.full_tokenizer.encode(value).ids)
                vectors.append(self.session.run(None,{'input_ids':np.asarray([encoded.ids],dtype=np.int64),
                     'attention_mask':np.asarray([encoded.attention_mask],dtype=np.int64)})[0][0].astype(np.float32))
                tokens += len(encoded.ids)
                dropped += max(0,full_count-len(encoded.ids))
            vector = np.concatenate([*vectors,surface_features(state['text'])])
            return self.intent_head['weights'] @ vector + self.intent_head['bias'], tokens, dropped, history_dropped

    def predict_intent(self, body):
        state, questions = user_intent.validate_request(body)
        started = time.perf_counter()
        logits, tokens, dropped, history_dropped = self.infer_intent(state)
        result = user_intent.answer(logits,self.intent_head)
        return dict(model=user_intent.PUBLIC_MODEL,answers={key:dict(result) for key in questions},
                    usage={'input_tokens':tokens,'output_tokens':0},truncated=bool(dropped or history_dropped),
                    state_tokens_dropped=dropped,history_tokens_dropped=history_dropped,
                    routing=dict(model=user_intent.PUBLIC_MODEL,revision=self.manifest['revision'],
                         head_revision=self.intent_head['head_revision'],calibration_revision=self.intent_head['calibration_revision'],
                         input_mode='previous-agent-first160-user-latest-v1',feature_mode='current-plus-context-charhash',
                         method='frozen_encoder_trained_head_with_character_features',encoder_calls=2,preliminary=True,
                         execution_providers=self.session.get_providers(),threads=4,
                         inference_ms=(time.perf_counter()-started)*1000))

    def intent_health(self):
        if not self.intent_head:
            return None
        return dict(model='in',artifact_model=user_intent.PUBLIC_MODEL,labels=list(user_intent.LABELS),
                    head_revision=self.intent_head['head_revision'],calibration_revision=self.intent_head['calibration_revision'],
                    temperature=self.intent_head['temperature'],preliminary=True,encoder_calls=2,max_tokens_per_call=512)
