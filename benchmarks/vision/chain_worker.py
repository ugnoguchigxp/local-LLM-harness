"""Local JSON-lines adapters for incompatible evaluation Python environments."""
import base64
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import traceback

sys.dont_write_bytecode = True
for name in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_DATASETS_OFFLINE']:
    os.environ[name] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['OMP_NUM_THREADS'] = '4'
os.environ['OPENBLAS_NUM_THREADS'] = '4'


def no_network(*args, **kwargs):
    raise RuntimeError('network forbidden during inference')


socket.create_connection = no_network
socket.socket.connect = no_network


def ruling_layout(image):
    import cv2
    import numpy as np
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY_INV)[1]
    horizontal = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, image.shape[1]//35), 1)))
    vertical = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, image.shape[0]//35))))

    def segments(binary):
        count, _, stats, _ = cv2.connectedComponentsWithStats(binary)
        return [[int(x), int(y), int(x+w), int(y+h)] for x, y, w, h, area in stats[1:count] if area >= 30]

    hs, vs = segments(horizontal), segments(vertical)
    groups = segments(cv2.bitwise_or(horizontal, vertical))
    regions = []
    for x1, y1, x2, y2 in groups:
        if x2-x1 < 150 or y2-y1 < 100:
            continue
        hlines = [s for s in hs if x1 <= s[0] < s[2] <= x2 and y1 <= s[1] <= y2 and s[2]-s[0] >= .15*(x2-x1)]
        vlines = [s for s in vs if x1 <= s[0] <= x2 and y1 <= s[1] < s[3] <= y2 and s[3]-s[1] >= .15*(y2-y1)]

        def cluster(values):
            output = []
            for value in sorted(values):
                if output and value-output[-1][-1] <= 5:
                    output[-1].append(value)
                else:
                    output.append([value])
            return [sum(group)/len(group) for group in output]

        xs = cluster([(s[0]+s[2])/2 for s in vlines])
        ys = cluster([(s[1]+s[3])/2 for s in hlines])
        if len(xs) < 2 or len(ys) < 2 or len(xs) > 25 or len(ys) > 50:
            continue
        rows, cols = len(ys)-1, len(xs)-1
        parent = list(range(rows*cols))

        def find(value):
            while parent[value] != value:
                parent[value] = parent[parent[value]]
                value = parent[value]
            return value

        def join(a, b):
            parent[find(a)] = find(b)

        for r in range(rows):
            for c in range(cols):
                cx, cy = (xs[c]+xs[c+1])/2, (ys[r]+ys[r+1])/2
                if c+1 < cols and not any(abs((s[0]+s[2])/2-xs[c+1]) <= 5 and s[1] <= cy <= s[3] for s in vlines):
                    join(r*cols+c, r*cols+c+1)
                if r+1 < rows and not any(abs((s[1]+s[3])/2-ys[r+1]) <= 5 and s[0] <= cx <= s[2] for s in hlines):
                    join(r*cols+c, (r+1)*cols+c)
        cells = {}
        for r in range(rows):
            for c in range(cols):
                cells.setdefault(find(r*cols+c), []).append((r, c))
        spans = []
        rectangular = True
        for group in cells.values():
            rr, cc = sorted({v[0] for v in group}), sorted({v[1] for v in group})
            if len(rr)*len(cc) != len(group):
                rectangular = False
            if len(group) > 1:
                spans.append({'rows': rr, 'columns': cc})
        regions.append({'box': [x1, y1, x2, y2], 'grid': {'rows': rows, 'columns': cols, 'merged': spans, 'xs': xs, 'ys': ys,
                        'rectangular': rectangular}, 'horizontal': hlines, 'vertical': vlines})
    return {'model': 'opencv-ruling-geometry', 'revision': cv2.__version__, 'regions': regions}


class Engines:
    def __init__(self, manifest):
        self.manifest = json.loads(Path(manifest).read_text())
        self.loaded = {}
        self.verified = set()
        self.torch = None

    def snapshot(self, name):
        record = self.manifest[name]
        pinned = json.loads(Path(__file__).with_name('models.json').read_text())[name]
        if any(record[key] != pinned[key] for key in ['repo', 'revision']):
            raise ValueError('unapproved model snapshot')
        if name not in self.verified:
            for entry in record['files']:
                with (Path(record['directory']) / entry['path']).open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                        raise ValueError('model checksum mismatch')
            self.verified.add(name)
        return record

    def torch_init(self):
        if self.torch is None:
            import torch
            torch.set_num_threads(4)
            torch.set_num_interop_threads(1)
            self.torch = torch
        return self.torch

    def call(self, operation, path):
        from PIL import Image
        if operation in ['ocr', 'objects', 'layout']:
            sys.path.insert(0, '/srv/ai/apps/vision-ocr-host')
            from vision_ocr.engines import OcrEngine, ObjectEngine, load_image
            image = load_image(path)
            if operation == 'layout':
                return ruling_layout(image)
            if operation not in self.loaded:
                config = {'models': json.loads(Path('/srv/ai/local-services-prepared/vision-ocr-production/models/models.json').read_text())}
                self.loaded[operation] = (OcrEngine if operation == 'ocr' else ObjectEngine)(config)
            return {**self.loaded[operation].infer(image), 'model': self.loaded[operation].model,
                    'revision': 'existing verified ONNX assets'}
        if operation == 'judge':
            sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps' / 'd1-system-one'))
            from engine import Engine
            if operation not in self.loaded:
                self.loaded[operation] = Engine('/srv/ai/models/d1-2b', device='cpu')
            image = Image.open(path).convert('RGB')
            image.thumbnail((384, 384))
            stream = io.BytesIO()
            image.save(stream, format='PNG')
            result = self.loaded[operation].predict({'model': 'd1-2b-game', 'state': 'Judge only the visible image.',
                'images': ['data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()],
                'questions': {'table': {'type': 'noul', 'instructions': 'Does the image contain a structured data table with rows and columns?'},
                              'formula': {'type': 'noul', 'instructions': 'Does the image contain a mathematical equation?'}}})
            return {**result, 'model': 'LiquidAI/d1-3B', 'revision': self.loaded[operation].health()['revision']}
        torch = self.torch_init()
        if operation == 'caption':
            record = self.snapshot('florence')
            if operation not in self.loaded:
                from transformers import AutoProcessor, AutoModelForCausalLM
                processor = AutoProcessor.from_pretrained(record['directory'], local_files_only=True, trust_remote_code=True)
                model = AutoModelForCausalLM.from_pretrained(record['directory'], torch_dtype=torch.float32,
                    local_files_only=True, trust_remote_code=True, attn_implementation='eager').eval()
                self.loaded[operation] = processor, model
            processor, model = self.loaded[operation]
            inputs = processor(text='<CAPTION>', images=Image.open(path).convert('RGB'), return_tensors='pt')
            with torch.inference_mode():
                ids = model.generate(**inputs, max_new_tokens=128, num_beams=3, do_sample=False)
            raw = processor.batch_decode(ids, skip_special_tokens=False)[0]
            text = processor.post_process_generation(raw, task='<CAPTION>', image_size=Image.open(path).size)['<CAPTION>']
            return {'model': record['repo'], 'revision': record['revision'], 'raw': raw,
                    'text': text, 'at_token_limit': ids.shape[-1]-1 >= 128}
        if operation in ['table-detection', 'table-structure']:
            from transformers import AutoConfig, AutoImageProcessor, AutoModelForObjectDetection
            record = self.snapshot('table-detection' if operation == 'table-detection' else 'table')
            if operation not in self.loaded:
                config = AutoConfig.from_pretrained(record['directory'], local_files_only=True)
                config.use_pretrained_backbone = False
                processor = AutoImageProcessor.from_pretrained(record['directory'], local_files_only=True)
                model, info = AutoModelForObjectDetection.from_pretrained(record['directory'], config=config,
                    local_files_only=True, output_loading_info=True)
                if info.get('missing_keys') or info.get('mismatched_keys') or any(
                    not key.endswith('num_batches_tracked') for key in info.get('unexpected_keys', [])):
                    raise ValueError('incompatible checkpoint tensors')
                self.loaded[operation] = processor, model.eval()
            processor, model = self.loaded[operation]
            image = Image.open(path).convert('RGB')
            with torch.inference_mode():
                output = model(**processor(images=image, return_tensors='pt'))
            post = processor.post_process_object_detection(output, threshold=.5,
                target_sizes=torch.tensor([[image.height, image.width]]))[0]
            return {'model': record['repo'], 'revision': record['revision'],
                    'objects': [{'label': model.config.id2label[int(label)], 'score': float(score), 'box': [float(v) for v in box]}
                                for label, score, box in zip(post['labels'], post['scores'], post['boxes'])]}
        if operation in ['formula', 'document']:
            from transformers import AutoProcessor, AutoModelForImageTextToText
            record = self.snapshot('docling')
            if 'docling' not in self.loaded:
                processor = AutoProcessor.from_pretrained(record['directory'], local_files_only=True)
                model = AutoModelForImageTextToText.from_pretrained(record['directory'], dtype=torch.float32,
                    local_files_only=True, attn_implementation='sdpa').eval()
                self.loaded['docling'] = processor, model
            processor, model = self.loaded['docling']
            image = Image.open(path).convert('RGB')
            instruction = 'Convert formula to LaTeX.' if operation == 'formula' else 'Convert this page to docling.'
            messages = [{'role': 'user', 'content': [{'type': 'image'}, {'type': 'text', 'text': instruction}]}]
            inputs = processor(text=processor.apply_chat_template(messages, add_generation_prompt=True), images=[image], return_tensors='pt')
            budget = 192 if operation == 'formula' else 1024
            with torch.inference_mode():
                ids = model.generate(**inputs, max_new_tokens=budget, do_sample=False, use_cache=True)
            generated = ids[:, inputs['input_ids'].shape[1]:]
            raw = processor.batch_decode(generated, skip_special_tokens=False)[0]
            result = {'model': record['repo'], 'revision': record['revision'], 'raw': raw,
                      'at_token_limit': generated.shape[-1] >= budget}
            if operation == 'formula':
                match = re.search(r'<formula>(.*?)</formula>', raw, re.S)
                result['latex'] = re.sub(r'<[^>]+>', '', match[1]).strip() if match else None
            else:
                from docling_core.types.doc import DoclingDocument
                from docling_core.types.doc.document import DocTagsDocument
                tags = DocTagsDocument.from_doctags_and_image_pairs([raw], [image])
                document = DoclingDocument.load_from_doctags(tags, document_name='image')
                result.update(markdown=document.export_to_markdown(),
                              table_text=[cell.text for table in document.tables for cell in table.data.table_cells])
            return result
        raise ValueError('unsupported operation')


def main():
    engines = Engines(sys.argv[1])
    seen = set()
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request['operation'] == 'stop':
                break
            with redirect_stdout(sys.stderr):
                result = engines.call(request['operation'], request['path'])
            result['operation_first_use'] = request['operation'] not in seen
            seen.add(request['operation'])
            response = {'ok': True, 'result': result}
        except Exception as error:
            response = {'ok': False, 'error': repr(error), 'traceback': traceback.format_exc()}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
