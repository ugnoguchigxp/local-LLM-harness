#!/usr/bin/env python3
"""Export a standalone chart of completed configurations' median RTF."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.input.is_absolute() or args.input.resolve() == repository or repository in args.input.resolve().parents:
        parser.error('Use an external results directory')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch
    import numpy as np
    rows = json.loads((args.input / 'summary.json').read_text())
    labels = {
        'voicevox-cpu': 'VOICEVOX CPU',
        'kokoro-cpu': 'Kokoro-82M CPU',
        'kokoro-gpu': 'Kokoro-82M GPU',
        'qwen-06-custom-official': 'Qwen 0.6B CustomVoice / official',
        'qwen-06-custom-production': 'Qwen 0.6B CustomVoice / optimized API',
        'qwen-06-base-official': 'Qwen 0.6B Base / official',
        'qwen-17-custom-official': 'Qwen 1.7B CustomVoice / official',
        'qwen-17-custom-optimized': 'Qwen 1.7B CustomVoice / optimized',
        'qwen-17-custom-optimized-retry': 'Qwen 1.7B CustomVoice / optimized',
        'qwen-17-base-official': 'Qwen 1.7B Base / official',
        'qwen-17-design-official': 'Qwen 1.7B VoiceDesign / official',
        'fish-s2-pro-eager': 'Fish S2 Pro / official PyTorch',
        'fish-s2-pro-eager-retry': 'Fish S2 Pro / PyTorch (ROCm compatibility)',
    }
    complete = {r['configuration'] for r in rows if r['completed']}
    names = [name for name in labels if name in complete]
    fig, ax = plt.subplots(figsize=(12, max(5, len(names) * .6)))
    positions = np.arange(len(names))
    for group, offset, color, label in [('ja', -.16, '#0072B2', 'Japanese'), ('en', .16, '#E69F00', 'English')]:
        values = {r['configuration']: r['median_rtf'] for r in rows if r['group'] == group and r['completed']}
        for index, name in enumerate(names):
            if name not in values:
                continue
            value = values[name]
            ax.barh(index + offset, value, height=.28, color=color)
            ax.text(value * 1.07, index + offset, f'{value:.3f}', va='center', fontsize=9,
                bbox={'facecolor': 'white', 'edgecolor': 'none', 'alpha': .8, 'pad': 1})
    ax.set_yticks(positions, [labels[name] for name in names])
    ax.invert_yaxis()
    ax.set_xscale('log')
    max_value = max(r['median_rtf'] for r in rows if r['completed'] and r['configuration'] in names)
    ax.set_xlim(.02, max(2, max_value * 1.7))
    ax.axvline(1, color='#555555', linestyle='--', linewidth=1)
    ax.set_xlabel('Median real-time factor (generation seconds / audio seconds; lower is faster)')
    ax.set_title('Multilingual TTS on Ryzen AI MAX+ 395 / Radeon 8060S\n3 repeats per utterance, single request, co-resident services')
    ax.grid(axis='x', alpha=.15)
    ax.legend(handles=[Patch(facecolor='#0072B2', label='Japanese'), Patch(facecolor='#E69F00', label='English')],
        loc='upper left', bbox_to_anchor=(1.01, 1), frameon=False)
    fig.tight_layout()
    fig.savefig(args.input / 'speed-comparison.png', dpi=180)
    fig.savefig(args.input / 'speed-comparison.svg')
    plt.close(fig)


if __name__ == '__main__':
    main()
