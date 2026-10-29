"""Pinned v3 intent feature formatting; shared ONNX execution lives in Engine."""
import hashlib
import re
import unicodedata

INSTRUCTION = '直前のエージェント発言を参考に、最新のユーザー発言の意図を分類する。'


def surface_features(text):
    """Fixed signed character hashing, including word-fragment end markers.

    No vocabulary, label or corpus frequency is learned from evaluation data.
    """
    import numpy as np
    text = '^' + re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).casefold() + '$'
    vector = np.zeros(4096, dtype=np.float32)
    for n in range(1, 5):
        for i in range(len(text)-n+1):
            digest = hashlib.blake2b(text[i:i+n].encode(), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], 'little') % 4096
            vector[bucket] += 1. if digest[4] & 1 else -1.
    vector = np.sign(vector) * np.log1p(np.abs(vector))
    norm = np.linalg.norm(vector)
    return vector / norm if norm else vector


def format_input(row, tokenizer):
    """Keep the first 160 history tokens; latest text remains the target.

    The completed input is right-truncated at 512 by the inference tokenizer.
    Metadata, notes, labels and toolchain never enter the encoder.
    """
    text = row['text']
    previous = row.get('previous_agent')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('text must be nonempty')
    if previous is not None and (not isinstance(previous, str) or not previous.strip()):
        raise ValueError('previous_agent must be nonempty or null')
    ids = tokenizer.encode(previous or '', add_special_tokens=False).ids
    history = tokenizer.decode(ids[:160], skip_special_tokens=False) if previous else '（なし）'
    return ('トピック: ' + INSTRUCTION + '\n[直前のエージェント発言]\n' + history
            + '\n[/直前のエージェント発言]\n[最新のユーザー発言・判断対象]\n' + text
            + '\n[/最新のユーザー発言・判断対象]'), max(0, len(ids) - 160)


def probabilities(logits, temperature):
    import numpy as np
    logits = np.asarray(logits, dtype=np.float64)
    if not np.isfinite(logits).all() or not np.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid logits or temperature')
    exp = np.exp((logits - logits.max(axis=-1, keepdims=True)) / temperature)
    return exp / exp.sum(axis=-1, keepdims=True)
