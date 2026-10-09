"""Independent LARM speaking-attitude protocol; no application dependencies."""
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LABELS = ['none', 'warmth', 'joy', 'empathy', 'curiosity', 'surprise']
CRITERIA = dict(zip(LABELS, [
    '通常。落ち着いた表情と声で事実、説明、操作手順を伝える。',
    '親しみ。温かな表情と声で挨拶、感謝、声かけをする。',
    '喜び。明るい表情と声で達成や良い知らせを一緒に喜ぶ。',
    '寄り添い。穏やかな表情と声で気遣い、安心を伝える。',
    '興味。関心のある表情と声で相手の話の続きを知りたがる。',
    '驚き。驚いた表情と声で予想外の出来事に反応する。',
]))
INSTRUCTION = ('判断対象は現在の回答チャンクだけ。アシスタント自身がそのチャンクを話す表情と声色を選ぶ。'
               '文章中の感情やユーザーの感情を分類しない。引用、否定、技術上の失敗は感情表現ではない。')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def load_examples(path=ROOT / 'examples.jsonl'):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    ids, conversation_splits, template_splits, sequences = set(), {}, {}, {}
    for row in rows:
        if row['id'] in ids:
            raise ValueError('duplicate example id')
        ids.add(row['id'])
        if row['primary_label'] not in LABELS or not set(row['acceptable_labels']) <= set(LABELS):
            raise ValueError('invalid labels')
        if row['primary_label'] not in row['acceptable_labels']:
            raise ValueError('primary label must be acceptable')
        if row['split'] not in ('train', 'calibration', 'eval'):
            raise ValueError('invalid split')
        for mapping, key in [(conversation_splits, row['conversation_id']), (template_splits, row['template_group'])]:
            if key in mapping and mapping[key] != row['split']:
                raise ValueError('conversation/template leakage across splits')
            mapping[key] = row['split']
        sequences.setdefault(row['conversation_id'], []).append(row)
    for seq in sequences.values():
        seq.sort(key=lambda r: r['chunk_order'])
        for i, row in enumerate(seq):
            if row['chunk_order'] != i:
                raise ValueError('chunks must be contiguous and start at zero')
            prev = seq[i - 1] if i else None
            expected = 'initial' if prev is None else ('hold' if prev['primary_label'] == row['primary_label'] else 'change')
            if row['expression_transition'] != expected:
                raise ValueError('transition label contradicts primary labels')
            row['_previous_chunk'] = prev['current_chunk'] if prev else ''
    # Exact repeated targets across partitions also signal possible unmarked template leakage.
    targets = {}
    for row in rows:
        target = row['current_chunk'].strip()
        if target in targets and targets[target] != row['split']:
            raise ValueError('identical target across splits')
        targets[target] = row['split']
    for i, row in enumerate(rows):
        for other in rows[i + 1:]:
            if row['split'] != other['split'] and difflib.SequenceMatcher(
                None, row['current_chunk'], other['current_chunk']).ratio() >= .8:
                raise ValueError('near-identical target template across splits')
    return sorted(rows, key=lambda r: (r['conversation_id'], r['chunk_order']))


def format_input(row, mode):
    if mode not in ('A', 'B', 'C'):
        raise ValueError('invalid input mode')
    parts = [INSTRUCTION]
    if mode in ('B', 'C'):
        parts.append('[ユーザー]\n' + row['user_utterance'] + '\n[/ユーザー]')
    if mode == 'C':
        parts.append('[アシスタント・直前チャンク・参考]\n' + (row['_previous_chunk'] or '（なし）') + '\n[/アシスタント・直前チャンク・参考]')
    parts.append('[アシスタント・現在チャンク・判断対象]\n' + row['current_chunk'] + '\n[/アシスタント・現在チャンク・判断対象]')
    return '\n'.join(parts)


def require_external(path):
    path = Path(path).resolve()
    repo = ROOT.parents[1]
    if path == repo or repo in path.parents:
        raise ValueError('weights, environments and run outputs must be outside the source repository')
    return path
