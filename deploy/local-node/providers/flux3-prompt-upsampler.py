#!/usr/bin/env python3
"""Expand one FLUX request using local-only official prompt upsampler weights."""
import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(sys.stdin.buffer.read(64 * 1024))
    # Imports and model allocation are confined to this short-lived process.
    import torch
    from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration
    prompts = json.loads((args.model / "system_prompts.json").read_text())
    processor = AutoProcessor.from_pretrained(args.model, local_files_only=True, trust_remote_code=False)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(args.model, dtype=torch.bfloat16,
        local_files_only=True, trust_remote_code=False).to("cuda").eval()
    messages = [{"role": "system", "content": prompts["t2i"]}, {"role": "user", "content":
        f'TARGET CANVAS: {request["width"]}:{request["height"]}\n{request["prompt"]}'}]
    inputs = processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=True,
        return_dict=True, return_tensors="pt", enable_thinking=False).to(model.device)
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=1536, do_sample=False)
    # A truncated caption must not silently drop requested content.
    if output.shape[1] - inputs["input_ids"].shape[1] >= 1536:
        raise RuntimeError("FLUX caption exceeded its token budget")
    caption = processor.decode(output[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
    if not 1 <= len(caption) <= 8192:
        raise RuntimeError("invalid FLUX caption")
    sys.stdout.write(json.dumps({"caption": caption}, ensure_ascii=False))


if __name__ == "__main__":
    main()
