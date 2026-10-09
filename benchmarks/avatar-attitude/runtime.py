"""Batch-one CPU adapters. Input embeddings are always recomputed."""
import json
import time
import numpy as np
import torch
from transformers import AutoConfig, AutoModel, AutoTokenizer
from common import CRITERIA, INSTRUCTION, LABELS


class Encoder:
    def __init__(self, config, path, onnx_path=None):
        self.config = config
        self.tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
        self.tokenizer.truncation_side = 'left'
        self.session = None
        if onnx_path:
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            self.session = ort.InferenceSession(str(onnx_path), options, providers=['CPUExecutionProvider'])
            if self.session.get_providers() != ['CPUExecutionProvider']:
                raise RuntimeError('unexpected execution provider')
            self.model = None
        else:
            cfg = AutoConfig.from_pretrained(path, local_files_only=True)
            cfg.reference_compile = False
            self.model = AutoModel.from_pretrained(path, config=cfg, local_files_only=True,
                                                  dtype=torch.float32, attn_implementation='sdpa').eval().cpu()
            if any(p.device.type != 'cpu' or p.dtype != torch.float32 for p in self.model.parameters()):
                raise RuntimeError('CPU FP32 requirement violated')
        self.tokens = 0
        self.truncated = False

    def encode(self, text):
        # Include tokenization in measured inference; do not cache any input feature.
        inputs = self.tokenizer(text, truncation=True, max_length=512, return_tensors='pt')
        self.tokens = int(inputs['input_ids'].shape[1])
        if self.session:
            feed = {x.name: inputs[x.name].numpy().astype(np.int64) for x in self.session.get_inputs()}
            return self.session.run(None, feed)[0][0].astype(np.float32)
        with torch.inference_mode():
            output = self.model(**inputs).last_hidden_state
            if self.config['pooling'] == 'cls':
                vec = output[:, 0]
            else:
                mask = inputs['attention_mask'].unsqueeze(-1).float()
                vec = (output * mask).sum(1) / mask.sum(1).clamp_min(1)
                vec = torch.nn.functional.normalize(vec, dim=-1)
        return vec[0].numpy().copy()


class AttitudeModel:
    def __init__(self, key, manifest, method='similarity', head_path=None, onnx_path=None):
        self.key = key
        self.config = manifest
        self.method = method
        self.encoder = None
        self.candidates = None
        self.head = None
        self.cached_candidates_ms = 0
        self.token_count = 0
        self.truncated = False
        if manifest['kind'] == 'laya':
            if onnx_path or method != 'similarity':
                raise ValueError('Laya uses its shipped typed decision head')
            from laya import Agent
            self.agent = Agent(manifest['path'], device='cpu', fast=False, compile=False)
            self.agent.amp_enabled = False
            self.agent.dtype = torch.float32
            self.agent.model.float().eval()
            self.questions = {'attitude': {'type': 'choice', 'instructions': INSTRUCTION, 'criteria': CRITERIA}}
            self.captured = None
            forward = self.agent._forward
            def capture(batch):
                output = forward(batch)
                self.captured = output[0][0, :6].copy()
                self.token_count = int(batch['input_ids'].shape[1])
                return output
            self.agent._forward = capture
            self.score_kind = 'laya_raw_logits'
            self.parameter_count = sum(p.numel() for p in self.agent.model.parameters())
            return
        if manifest['kind'] == 'head-only' and method != 'head':
            raise ValueError('ModernBERT-Ja is not a zero-shot sentence-embedding classifier')
        self.encoder = Encoder(manifest, manifest['path'], onnx_path)
        self.parameter_count = (sum(p.numel() for p in self.encoder.model.parameters())
                                if self.encoder.model is not None else None)
        if method == 'head':
            self.head = json.loads(head_path.read_text())
            if self.head['revision'] != manifest['revision'] or self.head['labels'] != LABELS:
                raise ValueError('head identity mismatch')
            self.score_kind = 'trained_linear_logits'
        else:
            self.score_kind = 'cosine_similarity'
            start = time.perf_counter()
            texts = [manifest['candidate_prefix'] + INSTRUCTION + '\n' + CRITERIA[label] for label in LABELS]
            # Fixed candidate cache only: one encoder call per candidate, batch=1.
            self.candidates = np.stack([self.encoder.encode(t) for t in texts])
            self.cached_candidates_ms = (time.perf_counter() - start) * 1000

    def predict(self, text, mode):
        if self.config['kind'] == 'laya':
            # Reject truncation which could silently remove the current target.
            result = self.agent.predict(text, self.questions, max_len=512, head_max_len=384)
            if self.agent.device.type != 'cpu' or self.agent.amp_enabled:
                raise RuntimeError('Laya fallback/precision changed')
            raw = self.captured.tolist()
            from laya.common import QTYPES, temp_bucket
            qt = QTYPES['choice']
            temp = self.agent.temperature_by_options.get(temp_bucket(qt, 6), self.agent.temperature[qt])
            return raw, (self.captured / temp).tolist(), result['answers']['attitude']['probabilities']
        vec = self.encoder.encode(self.config['input_prefix'] + text)
        self.token_count = self.encoder.tokens
        self.truncated = self.encoder.truncated
        if self.method == 'head':
            cfg = self.head['modes'][mode]
            scores = np.asarray(cfg['weights'], dtype=np.float32) @ vec + np.asarray(cfg['bias'], dtype=np.float32)
            return scores.tolist(), scores.tolist(), None
        scores = self.candidates @ vec
        return scores.tolist(), (scores * 20).tolist(), None

    def validate_input(self, text):
        if self.config['kind'] != 'laya':
            full = self.encoder.tokenizer(self.config['input_prefix'] + text, add_special_tokens=True)['input_ids']
            self.encoder.truncated = len(full) > 512
            return
        from laya.common import build_sequence
        q = {'t': 'choice', 'ins': INSTRUCTION, 'crit': CRITERIA}
        state_ids = self.agent.tok(text, add_special_tokens=False)['input_ids']
        seq, markers = build_sequence(self.agent.tok, text, q, max_len=100000, head_max_len=384)
        # No temporal context or target may disappear without being recorded.
        if len(seq) > 512 or len(markers) != 6:
            raise ValueError('Laya request exceeds complete 512-token budget')
        self.truncated = False
