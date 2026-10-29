#!/usr/bin/env python3
"""Build an external, local listening report from recorded TTS and ASR evidence."""
import argparse
from collections import defaultdict
import html
import json
import os
from pathlib import Path


def expressive_report(root, reference_root):
    esc = html.escape
    readings = [json.loads(s) for s in (root / 'readings.jsonl').read_text().splitlines()]
    transcripts = defaultdict(list)
    for row in readings:
        transcripts[(row['configuration'], row['case'])].append(row)
    configs = {}
    labels = {'05b': '0.5B・漢字入力', '05b-kana': '0.5B・読み指定',
        'tiny-int4': '軽量tiny・4bit・漢字入力', 'tiny-mixed4-8': '軽量tiny・4bit＋8bit・漢字入力',
        'tiny-mixed4-8-kana': '軽量tiny・4bit＋8bit・読み指定'}
    summary = {}
    for directory in sorted(root.iterdir()):
        if directory.is_dir() and (directory / 'completed.json').exists():
            rows = [json.loads(s) for s in (directory / 'runs.jsonl').read_text().splitlines()]
            configs[directory.name] = {r['case']: r for r in rows}
            load = json.loads((directory / 'load.json').read_text())
            summary[directory.name] = {'samples': len(rows), 'load': load,
                'gpu_peak_allocated_gib': max(load['gpu_peak_allocated_bytes'], max(r['gpu_peak_allocated_bytes'] for r in rows))/2**30,
                'gpu_peak_reserved_gib': max(load['gpu_peak_reserved_bytes'], max(r['gpu_peak_reserved_bytes'] for r in rows))/2**30,
                'generation_gpu_peak_allocated_gib': max(r['gpu_peak_allocated_bytes'] for r in rows)/2**30}
    preferred = ['tiny-mixed4-8-kana','05b-kana','tiny-int4','tiny-mixed4-8','05b']
    configs = dict(sorted(configs.items(), key=lambda kv: preferred.index(kv[0]) if kv[0] in preferred else len(preferred)))
    parts = ['<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
        '<title>Ming 日本語の抑揚サンプルと軽量化</title>',
        '<style>body{font:16px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;background:#f7f8fa;color:#17202c}table{border-collapse:collapse;width:100%;background:white}td,th{padding:.65rem;border:1px solid #ccd3dc;text-align:left;vertical-align:top}audio{max-width:100%;width:340px}section{margin:2rem 0}pre{white-space:pre-wrap}.note{background:#fff4d6;padding:1rem}details{margin:.7rem 0}</style>',
        '<h1>Ming 日本語の抑揚サンプルと軽量化</h1><p>2026年10月28日。以下は合成音声です。喜び・悲しみなどのラベルはモデルへの指定を示します。感情の実現度や自然さは聴き比べてください。</p>',
        '<p class="note">前回のtinyはGPU最大割当17.48GiB。今回は重みを圧縮して比較しています。CPUへ移すだけの削減ではありません。表は読み込みと生成を通じたPyTorchのGPUメモリ最大値です。CPU上で元の重みを読み込んでから圧縮するため、読み込み中にはCPU側に大きな一時メモリが必要です。共有メモリ全体のピーク削減を保証する試験ではありません。</p>',
        '<table><caption>今回の実測</caption><tr><th>構成</th><th>音声数</th><th>GPU最大割当</th><th>GPU最大予約</th></tr>']
    for name, cfg in summary.items():
        parts.append(f"<tr><th>{esc(labels.get(name,name))}</th><td>{cfg['samples']}</td><td>{cfg['gpu_peak_allocated_gib']:.2f}GiB</td><td>{cfg['gpu_peak_reserved_gib']:.2f}GiB</td></tr>")
    parts.append('</table><p>喜び・悲しみ・通常の3種類は同じ文章・同じseedです。励ましと優しい声は別の文章と話し方の指示を使います。読み指定版は、表示文の読みを仮名でモデルへ渡しています。漢字入力の精度とは別の条件です。音量・話速・ピッチの後加工はしていません。各条件1回の試作で、時間には初回準備が含まれ得ます。</p>')
    feedback_path = root / 'listening-feedback.json'
    if feedback_path.exists():
        feedback = json.loads(feedback_path.read_text())
        parts.append('<p class="note"><strong>利用者の試聴評価：</strong>' + esc(feedback['assessment']) + '</p>')
    cases = list(dict.fromkeys(case for cfg in configs.values() for case in cfg))
    order = ['neutral','happy','sad','surprised','encourage','gentle','ja-short','ja-numbers']
    cases.sort(key=lambda c: order.index(c) if c in order else len(order))
    for case in cases:
        sample = next(cfg[case] for cfg in configs.values() if case in cfg)
        parts.append(f"<section><h2>{esc(sample['label'])}（{esc(case)}）</h2><p>{esc(sample['text'])}</p><table><tr><th>構成</th><th>試聴・生成時間</th><th>読みの補助照合</th></tr>")
        for name, cfg in configs.items():
            if case not in cfg:
                continue
            row = cfg[case]
            url = esc(name + '/' + row['audio'], quote=True)
            reading = '<br>'.join(f"<strong>{esc(r['recognizer'])}</strong>: {esc(r.get('text',r.get('error','')))}" for r in transcripts[(name,case)])
            audio = f'<audio controls preload="none" src="{url}"></audio>'
            if not name.endswith('-kana') and not case.startswith('ja-'):
                audio = '<details><summary>漢字入力での試行（誤読あり）</summary>' + audio + '</details>'
            if row.get('model_input_text') != row['text'] and row.get('model_input_text'):
                reading += '<details><summary>実際の入力</summary>' + esc(row['model_input_text']) + '</details>'
            parts.append(f"<tr><th>{esc(labels.get(name,name))}</th><td>{audio}<br>生成{row['seconds']:.2f}秒 / 音声{row['audio_seconds']:.2f}秒</td><td>{reading}</td></tr>")
        if reference_root and case in ['ja-short','ja-numbers']:
            ref = reference_root / 'tiny-default/audio' / (case + '-0.wav')
            url = esc(os.path.relpath(ref,root),quote=True)
            parts.append(f'<tr><th>前回のtiny・17.5GiB</th><td><audio controls preload="none" src="{url}"></audio></td><td>同じ入力・seed 42の軽量化前との比較用</td></tr>')
        parts.append('</table></section>')
    parts.append('<p>音声認識による照合は読みの補助診断であり、感情表現や自然さの採点ではありません。音声認識側の誤りも含まれます。</p></html>')
    (root / 'index.html').write_text('\n'.join(parts)+'\n')
    (root / 'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--expressive', action='store_true')
    p.add_argument('--reference-root', type=Path)
    args = p.parse_args()
    repo = Path(__file__).resolve().parents[3]
    if not args.root.is_absolute() or args.root.resolve() == repo or repo in args.root.resolve().parents:
        p.error('Results must be outside the source repository')
    root = args.root
    if args.expressive:
        expressive_report(root, args.reference_root)
        return
    readings = [json.loads(s) for s in (root / 'readings.jsonl').read_text().splitlines()]
    readings_by_clip = defaultdict(list)
    for row in readings:
        readings_by_clip[(row['configuration'], row['case'], row['iteration'])].append(row)
    configurations = {}
    cases = {}
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or not (directory / 'completed.json').exists():
            continue
        rows = [json.loads(s) for s in (directory / 'runs.jsonl').read_text().splitlines()]
        measured = [r for r in rows if not r.get('warmup') and r.get('success')]
        configs = {'timing': json.loads((directory / 'completed.json').read_text()), 'recognizers': {}}
        for recognizer in sorted({r['recognizer'] for r in readings}):
            group = [r for r in readings if r['configuration'] == directory.name and r['recognizer'] == recognizer and r.get('success')]
            if group:
                configs['recognizers'][recognizer] = {'clips': len(group),
                    'cer': sum(r['edits'] for r in group) / sum(r['reference_characters'] for r in group),
                    'kana_cer': sum(r['kana_edits'] for r in group) / sum(r['kana_reference_characters'] for r in group)}
        configurations[directory.name] = configs
        for row in measured:
            cases.setdefault(row['case'], {'text': row['text'], 'configurations': defaultdict(list)})['configurations'][directory.name].append(row)
    (root / 'summary.json').write_text(json.dumps(configurations, ensure_ascii=False, indent=2) + '\n')
    esc = html.escape
    parts = ['<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
        '<title>Ming 3.0 TTS 日本語実機評価</title>',
        '<style>body{font:16px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;background:#f7f8fa;color:#17202c}table{border-collapse:collapse;width:100%;background:white}td,th{padding:.65rem;border:1px solid #cdd3dc;text-align:left;vertical-align:top}audio{max-width:100%;width:350px}section{margin:2rem 0}pre{white-space:pre-wrap}details{margin:.8rem 0}.note{background:#fff4d6;padding:1rem}</style>',
        '<h1>Ming 3.0 TTS 日本語実機評価</h1><p>2026年10月28日。Ryzen AI Max+ 395 / Radeon 8060S。以下は合成音声です。</p>',
        '<p class="note">読みの照合はQwen3-ASRとWhisperによる補助診断です。認識器と読み辞書にも誤りがあるため、人間の発音正答率・自然さ・MOSとは異なります。RTFは生成時間÷音声長で、1未満なら再生時間より速い値です。音声保存はMingの計測外、VOICEVOXはHTTP転送を含みます。すべて既存サービスとの共存状態です。</p>',
        '<p>VOICEVOX音声および日本語参照条件のcredit: VOICEVOX:春日部つむぎ。</p>',
        '<table><caption>構成ごとの実測</caption><tr><th>構成</th><th>通常生成</th><th>短文中央値</th><th>長文中央値</th><th>RTF中央値</th><th>ASR診断CER / 読みCER</th></tr>']
    for name, cfg in configurations.items():
        timing = cfg['timing']
        def seconds(case):
            value = timing['cases'].get(case)
            return f"{value['seconds_median']:.3f}秒" if value else '未測定'
        scores = '<br>'.join(f"{esc(k)}: {v['cer']:.1%} / {v['kana_cer']:.1%}" for k, v in cfg['recognizers'].items())
        parts.append(f"<tr><th>{esc(name)}</th><td>{timing['successes']}本</td><td>{seconds('ja-short')}</td><td>{seconds('ja-long')}</td><td>{timing['rtf_median']:.3f}</td><td>{scores}</td></tr>")
    parts.append('</table><p>05b-defaultは公式の中国語参照音声と既定分割。05b-ja-referenceはVOICEVOX合成の日本語参照。tinyは公開のMoE loop経路です。参照条件・実行経路の違いをモデルサイズだけの差と解釈しないでください。</p>')
    for case_id, case in cases.items():
        parts.append(f"<section><h2>{esc(case_id)}</h2><p>{esc(case['text'])}</p><table><tr><th>構成</th><th>試聴・測定</th><th>認識された内容</th></tr>")
        for name, rows in case['configurations'].items():
            for row in rows:
                score = '<br>'.join(f"<strong>{esc(r['recognizer'])}</strong>: {esc(r.get('text', r.get('error', '')))}" for r in readings_by_clip[(name, case_id, row['iteration'])])
                url = esc(f"{name}/{row['audio']}", quote=True)
                audio = f'<audio controls preload="none" src="{url}"></audio>'
                if row['iteration'] != 0:
                    audio = f'<details><summary>別seedの試聴</summary>{audio}</details>'
                if row.get('stopped') is False:
                    audio += '<p>停止判定に未到達。生成上限に達した音声です。</p>'
                parts.append(f"<tr><th>{esc(name)} / {row['iteration']}</th><td>{audio}<br>生成{row['seconds']:.3f}秒 / 音声{row['audio_seconds']:.2f}秒 / RTF {row['rtf']:.3f}</td><td>{score}</td></tr>")
        parts.append('</table></section>')
    parts.append('</html>')
    (root / 'index.html').write_text('\n'.join(parts) + '\n')
    print(json.dumps(configurations, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
