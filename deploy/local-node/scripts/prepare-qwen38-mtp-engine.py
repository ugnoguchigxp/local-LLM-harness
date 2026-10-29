#!/usr/bin/env python3
"""Build the single-head MTP variant with scoped retention and boundary state."""
from pathlib import Path
import runpy


if __name__ == '__main__':
    build = runpy.run_path(str(Path(__file__).with_name('prepare-qwen38-retention-engine.py')))['main']
    build(source_default='/srv/ai/apps/qwen38-rocmfp4-mtp-source-120141f',
          output_default='/srv/ai/apps/larm-qwen38-mtp-120141f-v3',
          patch_name='llama-prompt-retention-rocmfpx-120141f-mtp-v1.patch',
          test_name='larm-prompt-retention-test-mtp.cpp', mtp=True)
