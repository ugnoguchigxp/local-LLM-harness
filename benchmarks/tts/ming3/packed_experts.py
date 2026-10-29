"""Experimental groupwise INT4 expert storage, with portable BF16 linear math.

This is a memory/quality experiment, not an optimized quantized inference kernel.
By default only routed experts are compressed. The optional compact-dense path
also stores the remaining nn.Linear weights as INT8. Routers that use custom
parameters and embeddings stay unchanged. Convert on CPU before GPU placement.
"""
import re

import torch
from torch import nn
from torch.nn import functional as F


class PackedExpertLinear(nn.Module):
    def __init__(self, linear, group_size=64):
        super().__init__()
        if linear.weight.device.type != 'cpu':
            raise ValueError('Pack experts on CPU before GPU placement')
        self.in_features = linear.in_features
        self.out_features = linear.out_features
        self.group_size = group_size
        if self.in_features % group_size or self.in_features % 2:
            raise ValueError('Input features must be divisible by the packing group')
        weight = linear.weight.detach().float().reshape(self.out_features, -1, group_size)
        minimum = weight.amin(-1, keepdim=True).clamp(max=0)
        maximum = weight.amax(-1, keepdim=True).clamp(min=0)
        scale = ((maximum - minimum) / 15).clamp_min(1e-8)
        codes = ((weight - minimum) / scale).round().clamp(0, 15).to(torch.uint8)
        codes = codes.reshape(self.out_features, self.in_features)
        packed = codes[:, 0::2] | (codes[:, 1::2] << 4)
        self.register_buffer('packed', packed.contiguous())
        self.register_buffer('scale', scale.to(torch.bfloat16))
        self.register_buffer('minimum', minimum.to(torch.bfloat16))
        self.register_buffer('bias', None if linear.bias is None else linear.bias.detach().clone())

    def dequantize(self):
        codes = torch.stack((self.packed & 15, self.packed >> 4), dim=-1)
        codes = codes.reshape(self.out_features, -1, self.group_size).to(self.scale.dtype)
        return (codes * self.scale + self.minimum).reshape(self.out_features, self.in_features)

    def forward(self, inputs):
        return F.linear(inputs, self.dequantize(), self.bias)


def pack_routed_experts(model, group_size=64):
    selected = [(name, module) for name, module in model.named_modules()
                if re.fullmatch(r'model\.model\.layers\.\d+\.mlp\.experts\.\d+\.(gate|up|down)_proj', name)
                and isinstance(module, nn.Linear)]
    if len(selected) != 23 * 128 * 3:
        raise RuntimeError(f'Unexpected routed expert layout: {len(selected)} linears')
    before = sum(m.weight.numel() * m.weight.element_size() for _, m in selected)
    after = 0
    old_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        for index, (name, module) in enumerate(selected, 1):
            packed = PackedExpertLinear(module, group_size)
            parent_name, child = name.rsplit('.', 1)
            setattr(model.get_submodule(parent_name), child, packed)
            after += sum(b.numel() * b.element_size() for b in packed.buffers())
            # Release the old CPU weight rather than retaining every selected module.
            selected[index - 1] = (name, None)
            if index % (128 * 3) == 0:
                print(f'INT4 packed layer {index // (128 * 3)}/23', flush=True)
    finally:
        torch.set_num_threads(old_threads)
    return {'linears': len(selected), 'group_size': group_size,
            'original_weight_bytes': before, 'packed_weight_bytes': after,
            'quantization': 'affine unsigned INT4, per output row and input group',
            'execution': 'dequantize selected linear to BF16 per call; no persistent dequant cache'}


class PackedDenseInt8(nn.Module):
    """Per-output-row INT8 storage for the remaining nn.Linear weights."""
    def __init__(self, linear):
        super().__init__()
        self.in_features, self.out_features = linear.in_features, linear.out_features
        if linear.weight.device.type != 'cpu':
            raise ValueError('Compress weights before GPU placement')
        weight = linear.weight.detach().float()
        scale = (weight.abs().amax(-1, keepdim=True) / 127).clamp_min(1e-8)
        self.register_buffer('codes', (weight / scale).round().clamp(-127, 127).to(torch.int8))
        self.register_buffer('scale', scale.to(linear.weight.dtype))
        self.register_buffer('bias', None if linear.bias is None else linear.bias.detach().clone())

    @property
    def weight(self):
        return self.codes.to(self.scale.dtype) * self.scale

    def forward(self, inputs):
        return F.linear(inputs, self.weight, self.bias)


def pack_other_linears(model):
    selected = [(name, module) for name, module in model.named_modules() if isinstance(module, nn.Linear)]
    before = sum(m.weight.numel() * m.weight.element_size() for _, m in selected)
    after = 0
    old_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        for index, (name, module) in enumerate(selected):
            parent_name, separator, child = name.rpartition('.')
            packed = PackedDenseInt8(module)
            parent = model.get_submodule(parent_name) if separator else model
            setattr(parent, child, packed)
            after += sum(b.numel() * b.element_size() for b in packed.buffers())
            selected[index] = (name, None)
    finally:
        torch.set_num_threads(old_threads)
    return {'linears': len(selected), 'original_weight_bytes': before, 'packed_bytes_including_bias': after,
            'quantization': 'remaining nn.Linear: symmetric per-output-row INT8; other parameters unchanged'}


def install_cpu_pack_hook(group_size=64, compact_dense=False):
    from ming_tiny.modeling_lingv3_tts import LingV3TTSForConditionalGeneration
    native_to = LingV3TTSForConditionalGeneration.to
    def pack_before_gpu(self, *args, **kwargs):
        if not hasattr(self, '_larm_packed_experts'):
            self._larm_packed_experts = pack_routed_experts(self, group_size)
            if compact_dense:
                self._larm_packed_experts['additional_int8'] = pack_other_linears(self)
        return native_to(self, *args, **kwargs)
    LingV3TTSForConditionalGeneration.to = pack_before_gpu
