"""CPU checks for packing order, reconstruction and module replacement."""
import copy
import unittest

import torch
from torch import nn

from packed_experts import PackedDenseInt8, PackedExpertLinear, pack_other_linears


class PackingTests(unittest.TestCase):
    def test_nibbles_preserve_feature_order(self):
        linear = nn.Linear(64, 1, bias=False, dtype=torch.bfloat16)
        linear.weight.data.copy_(torch.arange(16).repeat(4).reshape(1, 64))
        packed = PackedExpertLinear(linear)
        self.assertEqual(packed.packed.flatten().tolist(), [0x10,0x32,0x54,0x76,0x98,0xBA,0xDC,0xFE]*4)
        torch.testing.assert_close(packed.dequantize(), linear.weight, rtol=0, atol=0)

    def test_zero_row_and_bias(self):
        linear = nn.Linear(64, 2, dtype=torch.bfloat16)
        linear.weight.data.zero_(); linear.bias.data.copy_(torch.tensor([2., -3.]))
        for cls in [PackedExpertLinear, PackedDenseInt8]:
            result = cls(linear)(torch.ones(3, 64, dtype=torch.bfloat16))
            torch.testing.assert_close(result, torch.tensor([[2.,-3.]]*3, dtype=torch.bfloat16))

    def test_root_and_nested_dense_linears(self):
        torch.manual_seed(42)
        model = nn.Module()
        model.head = nn.Linear(64, 16, dtype=torch.bfloat16)
        model.nested = nn.Sequential(nn.Linear(16, 8, dtype=torch.bfloat16))
        reference = copy.deepcopy(model)
        report = pack_other_linears(model)
        self.assertEqual(report['linears'], 2)
        self.assertIsInstance(model.head, PackedDenseInt8)
        self.assertIsInstance(model.nested[0], PackedDenseInt8)
        x = torch.randn(4, 64, dtype=torch.bfloat16)
        expected = reference.nested(reference.head(x)).float()
        actual = model.nested(model.head(x)).float()
        relative_rms = (actual-expected).square().mean().sqrt()/expected.square().mean().sqrt()
        self.assertLess(relative_rms.item(), .02)


if __name__ == '__main__':
    unittest.main()
