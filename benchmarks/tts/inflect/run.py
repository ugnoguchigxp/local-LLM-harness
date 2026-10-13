#!/usr/bin/env python3
"""Inflect Nano v2 English baseline and unsupported Japanese experiments."""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime', required=True, type=Path)
    p.add_argument('--model', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--repeats', type=int, default=3)
    p.add_argument('--cases', help='Comma-separated case IDs; defaults to the complete corpus')
    args = p.parse_args()
    repo = Path(__file__).resolve().parents[3]
    for dest in [args.runtime, args.model, args.output]:
        if not dest.is_absolute() or dest.resolve() == repo or repo in dest.resolve().parents:
            p.error('Runtime, weights and generated results must be outside the source repository')
    sys.path.insert(0, str(args.runtime))
    import numpy as np
    import soundfile as sf
    import torch
    from inference import InflectTTS, edge_fade
    import commons
    from text import cleaned_text_to_sequence
    from text.symbols import symbols
    from inflect_vits_frontend import run_vits_frontend
    import pyopenjtalk
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    args.output.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    engine = InflectTTS(args.model, device='cpu')
    load_s = time.perf_counter() - start
    start = time.perf_counter()
    engine.synthesize('The complete model runs locally.', seed=42)
    warmup_s = time.perf_counter() - start
    phone_map = {x: x for x in ['a','i','e','o','k','g','s','z','t','d','n','h','b','p','m','w','y']}
    phone_map.update(u='ɯ', r='ɾ', N='ɴ', sh='ɕ', ch='tɕ', j='dʑ', ts='ts', f='ɸ', cl='ʔ', pau=',', sil='')
    phone_map.update({x+'y': phone_map[x]+'j' for x in ['k','g','n','h','b','p','m','r']})
    phone_map['y'] = 'j'
    english_map = dict(phone_map, u='u', r='ɹ', N='n', sh='ʃ', ch='tʃ', j='dʒ', f='f')
    english_map.update({x+'y': english_map[x]+'j' for x in ['k','g','n','h','b','p','m','r']})
    corpus = json.loads(Path(__file__).with_name('corpus.json').read_text())
    records = []
    for case in corpus:
        if args.cases and case['id'] not in args.cases.split(','):
            continue
        row = dict(case, expected=case.get('expected',case['text']), measurements=[])
        try:
            if case['mode'] in ['japanese-ipa', 'raw-ipa']:
                phones = pyopenjtalk.g2p(case['text']).split() if case['mode'] == 'japanese-ipa' else []
                mapping = english_map if case.get('mapping') == 'english' else phone_map
                # No retraining: approximate Japanese phonemes with the existing symbol inventory.
                phonemes = case['phonemes'] if case['mode'] == 'raw-ipa' else ''.join(mapping[phone.lower() if phone in ['A','I','U','E','O'] else phone] for phone in phones) + '.'
                unknown = sorted(set(phonemes) - set(symbols))
                if unknown:
                    raise ValueError(f'Unsupported IPA symbols: {unknown}')
                row.update(openjtalk_phones=phones, phonemes=phonemes)
            else:
                front = run_vits_frontend(case['text'])
                row['frontend'] = asdict(front)
                row['phonemes'] = front.phoneme_text
            for repeat in range(args.repeats):
                start = time.perf_counter()
                if case['mode'] in ['japanese-ipa', 'raw-ipa']:
                    # Automatic IPA cases include G2P time; manually authored IPA starts at tokenization.
                    phones = pyopenjtalk.g2p(case['text']).split() if case['mode'] == 'japanese-ipa' else []
                    phonemes = case['phonemes'] if case['mode'] == 'raw-ipa' else ''.join(mapping[phone.lower() if phone in ['A','I','U','E','O'] else phone] for phone in phones) + '.'
                    sequence = cleaned_text_to_sequence(phonemes)
                    if engine.hps.data.add_blank:
                        sequence = commons.intersperse(sequence, 0)
                    tokens = torch.LongTensor(sequence).unsqueeze(0)
                    lengths = torch.LongTensor([tokens.size(1)])
                    torch.manual_seed(42 + repeat)
                    with torch.inference_mode():
                        waveform = engine.model.infer(tokens, lengths, noise_scale=0.667, noise_scale_w=0.8, length_scale=1.0/case.get('speed',1.0), max_len=4000)[0][0,0].float().numpy()
                    waveform = np.clip(edge_fade(waveform,engine.sample_rate),-1,1)
                    sr = engine.sample_rate
                else:
                    sr, waveform = engine.synthesize(case['text'],seed=42+repeat)
                elapsed = time.perf_counter()-start
                audio = args.output / f"{case['id']}-{repeat}.wav"
                sf.write(audio,waveform,sr,subtype='PCM_16')
                duration = len(waveform)/sr
                row['measurements'].append(dict(seed=42+repeat,elapsed_s=elapsed,audio_s=duration,rtf=elapsed/duration,audio=str(audio),sha256=hashlib.sha256(audio.read_bytes()).hexdigest(),peak=float(np.max(np.abs(waveform))),rms=float(np.sqrt(np.mean(waveform**2)))))
            row.update(success=True,median_s=statistics.median(m['elapsed_s'] for m in row['measurements']),median_rtf=statistics.median(m['rtf'] for m in row['measurements']))
        except Exception as exc:
            row.update(success=False,error=f'{type(exc).__name__}: {exc}')
        records.append(row)
        print(json.dumps(row,ensure_ascii=False),flush=True)
        result = dict(model='Inflect-Nano-v2',device='cpu',threads=args.threads,torch=torch.__version__,sample_rate=engine.sample_rate,deployed_parameters=engine.deployed_parameters,load_s=load_s,warmup_s=warmup_s,runtime=str(args.runtime),model_dir=str(args.model),speed=1.0,variation=0.667,checkpoint_parameters=engine.checkpoint_parameters,rows=records)
        (args.output/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')


if __name__ == '__main__':
    main()
