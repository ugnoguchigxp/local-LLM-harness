"""Export a pinned encoder with its pooling, then quantize linear MatMul/Gemm weights."""
import argparse
import json
from pathlib import Path
import numpy as np
import torch
from common import ROOT, CRITERIA, INSTRUCTION, LABELS, format_input, load_examples, require_external, sha256, write_json
from runtime import Encoder


class PooledEncoder(torch.nn.Module):
    def __init__(self, model, pooling):
        super().__init__()
        self.model, self.pooling = model, pooling

    def forward(self, input_ids, attention_mask):
        states=self.model(input_ids=input_ids,attention_mask=attention_mask).last_hidden_state
        if self.pooling=='cls': return states[:,0]
        mask=attention_mask.unsqueeze(-1).float()
        vector=(states*mask).sum(1)/mask.sum(1).clamp_min(1)
        return torch.nn.functional.normalize(vector,dim=-1)


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--sandbox',required=True)
    p.add_argument('--model',choices=['ruri30','ruri70','verdict','modernbert30'],required=True)
    a=p.parse_args()
    root=require_external(a.sandbox)
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    manifest=json.loads((root/'artifacts'/(a.model+'-manifest.json')).read_text())
    encoder=Encoder(manifest,manifest['path'])
    parameter_count=sum(p.numel() for p in encoder.model.parameters())
    wrapper=PooledEncoder(encoder.model,manifest['pooling']).eval()
    sample=encoder.tokenizer('トピック: 現在のチャンクを穏やかな声で伝える。',return_tensors='pt')
    fp32=root/'onnx'/(a.model+'-fp32.onnx')
    int8=root/'onnx'/(a.model+'-int8.onnx')
    fp32.parent.mkdir(parents=True,exist_ok=True)
    with torch.inference_mode():
        torch.onnx.export(wrapper,(sample['input_ids'],sample['attention_mask']),str(fp32),
                          input_names=['input_ids','attention_mask'],output_names=['embedding'],
                          dynamic_axes={'input_ids':{0:'batch',1:'sequence'},'attention_mask':{0:'batch',1:'sequence'},'embedding':{0:'batch'}},
                          opset_version=18,dynamo=False)
    from onnxruntime.quantization import quantize_dynamic,QuantType
    quantize_dynamic(str(fp32),str(int8),weight_type=QuantType.QInt8,per_channel=True,
                     op_types_to_quantize=['MatMul','Gemm'])
    import onnx
    graph=onnx.load(str(int8))
    quantized=sum(n.op_type in ['MatMulInteger','DynamicQuantizeLinear','QLinearMatMul'] for n in graph.graph.node)
    if quantized==0: raise RuntimeError('no quantized operators; do not label this INT8')
    import onnxruntime as ort
    options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
    session=ort.InferenceSession(str(int8),options,providers=['CPUExecutionProvider'])
    fp32_session=ort.InferenceSession(str(fp32),options,providers=['CPUExecutionProvider'])
    from tokenizers import Tokenizer
    raw_tokenizer=Tokenizer.from_file(str(Path(manifest['path'])/'tokenizer.json'))
    raw_tokenizer.enable_truncation(max_length=512,direction='left')
    equivalence_texts=[manifest['input_prefix']+format_input(r,m) for r in load_examples() for m in 'ABC']
    if manifest['kind']=='embedding':
        equivalence_texts += [manifest['candidate_prefix']+INSTRUCTION+'\n'+CRITERIA[l] for l in LABELS]
    for text in equivalence_texts:
        expected=encoder.tokenizer(text,truncation=True,max_length=512)['input_ids']
        if expected!=raw_tokenizer.encode(text).ids:
            raise RuntimeError('standalone Tokenizers differs on experiment inputs')
    checks=[]
    for text in ['短い文。','あいうえお。'*70,'確認。'*260]:
        inputs=encoder.tokenizer(text,truncation=True,max_length=512,return_tensors='pt')
        reference=encoder.encode(text)
        if inputs['input_ids'][0].tolist()!=raw_tokenizer.encode(text).ids:
            raise RuntimeError('standalone Tokenizers differs from Transformers')
        fp32_result=fp32_session.run(None,{x.name:inputs[x.name].numpy() for x in fp32_session.get_inputs()})[0][0]
        if not np.allclose(reference,fp32_result,rtol=1e-3,atol=5e-4):
            raise RuntimeError('ONNX FP32 is not equivalent to the source encoder')
        result=session.run(None,{x.name:inputs[x.name].numpy() for x in session.get_inputs()})[0][0]
        checks.append(dict(tokens=int(inputs['input_ids'].shape[1]),fp32_max_abs_diff=float(np.abs(reference-fp32_result).max()),max_abs_diff=float(np.abs(reference-result).max()),
                           cosine=float(reference@result/(np.linalg.norm(reference)*np.linalg.norm(result)))))
    write_json(root/'onnx'/(a.model+'-export.json'),dict(model=a.model,revision=manifest['revision'],
               parameter_count=parameter_count,source_sha256=sha256(__file__),fp32_sha256=sha256(fp32),int8_sha256=sha256(int8),
               quantization='dynamic per-channel QInt8 MatMul/Gemm; embeddings/normalization/pooling remain FP32',
               quantized_node_count=quantized,fp32_bytes=fp32.stat().st_size,int8_bytes=int8.stat().st_size,
               execution_providers=session.get_providers(),tokenizer_equivalence_examples=len(equivalence_texts),dynamic_shape_checks=checks,
               opset=18,pooling=manifest['pooling']))
    print(int8,quantized,'quantized nodes',checks,flush=True)
