"""CPU ONNX deployment adapter using Tokenizers, NumPy and ORT, without importing Torch."""
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
from common import CRITERIA, INSTRUCTION, LABELS, sha256


class AttitudeModel:
    def __init__(self, key, manifest, method='similarity', head_path=None, onnx_path=None):
        self.key,self.config,self.method=key,manifest,method
        if manifest['kind']=='laya' or not onnx_path:
            raise ValueError('this adapter requires an exported encoder')
        export=json.loads((onnx_path.parent/(key+'-export.json')).read_text())
        if export['revision']!=manifest['revision'] or export['int8_sha256']!=sha256(onnx_path) or export['quantized_node_count']==0:
            raise ValueError('INT8 artifact/export manifest mismatch')
        self.parameter_count=export['parameter_count']
        options=ort.SessionOptions()
        options.intra_op_num_threads=4
        options.inter_op_num_threads=1
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        self.session=ort.InferenceSession(str(onnx_path),options,providers=['CPUExecutionProvider'])
        if self.session.get_providers()!=['CPUExecutionProvider']:
            raise RuntimeError('unexpected execution provider')
        self.tokenizer=Tokenizer.from_file(str(Path(manifest['path'])/'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=512,direction='left')
        self.candidates,self.head=None,None
        self.cached_candidates_ms=0.
        self.token_count=0
        self.truncated=False
        if method=='head':
            self.head=json.loads(head_path.read_text())
            if self.head['revision']!=manifest['revision'] or self.head['labels']!=LABELS:
                raise ValueError('head identity mismatch')
            self.score_kind='trained_linear_logits'
        else:
            if manifest['kind']=='head-only': raise ValueError('model requires a trained head')
            self.score_kind='cosine_similarity'
            start=time.perf_counter()
            self.candidates=np.stack([self.encode(manifest['candidate_prefix']+INSTRUCTION+'\n'+CRITERIA[l]) for l in LABELS])
            self.cached_candidates_ms=(time.perf_counter()-start)*1000

    def encode(self,text):
        encoded=self.tokenizer.encode(text)
        self.token_count=len(encoded.ids)
        self.truncated=bool(encoded.overflowing)
        feed={'input_ids':np.asarray([encoded.ids],dtype=np.int64),
              'attention_mask':np.asarray([encoded.attention_mask],dtype=np.int64)}
        return self.session.run(None,feed)[0][0].astype(np.float32)

    def validate_input(self,text):
        pass  # Tokenizers records overflows in the timed encoding itself.

    def predict(self,text,mode):
        vector=self.encode(self.config['input_prefix']+text)
        if self.method=='head':
            cfg=self.head['modes'][mode]
            scores=np.asarray(cfg['weights'],dtype=np.float32)@vector+np.asarray(cfg['bias'],dtype=np.float32)
            return scores.tolist(),scores.tolist(),None
        scores=self.candidates@vector
        return scores.tolist(),(20*scores).tolist(),None
