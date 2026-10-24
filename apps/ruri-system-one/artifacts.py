"""Artifact identity checks, usable without inference framework imports."""
import hashlib
import json
import math
from pathlib import Path
from attitude import LABELS, PUBLIC_MODEL, validate_contract

FILES = {'head.json', 'calibration.json', 'model.onnx', 'tokenizer.json'}


def verify_assets(root, manifest):
    entries = manifest.get('files', [])
    if len(entries) != len(FILES) or {f['path'] for f in entries} != FILES:
        raise ValueError('manifest must name exactly the four supported artifacts')
    for entry in entries:
        path = root / entry['path']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes']:
            raise ValueError('missing or invalid Ruri artifact: ' + entry['path'])
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError('Ruri artifact checksum mismatch: ' + entry['path'])


def load_artifacts(root, manifest_path=None):
    root = Path(root)
    if root.is_symlink():
        raise ValueError('model root must be an immutable directory, not a symlink')
    manifest = json.loads(Path(manifest_path or Path(__file__).with_name('assets.json')).read_text())
    verify_assets(root, manifest)
    contract = validate_contract(manifest['contract']) if 'contract' in manifest else None
    labels = contract['labels'] if contract else list(LABELS)
    head = json.loads((root/'head.json').read_text())
    calibration = json.loads((root/'calibration.json').read_text())
    if (head.get('revision') != manifest['revision'] or head.get('labels') != labels
            or head.get('encoder_frozen') is not True or head.get('train_only') is not True):
        raise ValueError('Ruri head provenance mismatch')
    expected = {f['path']: f['sha256'] for f in manifest['files']}
    if (calibration.get('head_sha256') != expected['head.json']
            or calibration.get('revision') != head['revision']
            or calibration.get('input_mode') != 'A' or calibration.get('evaluation_labels_used') is not False
            or calibration.get('calibration_ids') != head.get('calibration_ids')
            or calibration.get('data_sha256') != head.get('data_sha256')):
        raise ValueError('Ruri calibration provenance mismatch')
    train, cal = head.get('train_ids', []), head.get('calibration_ids', [])
    if (not train or not cal or any(not isinstance(i, str) or not i for i in train+cal)
            or len(set(train)) != len(train) or len(set(cal)) != len(cal) or set(train) & set(cal)):
        raise ValueError('invalid or overlapping training/calibration identities')
    if contract:
        if (head.get('contract') != contract or calibration.get('contract') != contract
                or calibration.get('labels') != labels
                or calibration.get('inference_encoder_sha256') != expected['model.onnx']
                or calibration.get('tokenizer_sha256') != expected['tokenizer.json']
                or manifest.get('input_mode') != 'A'
                or manifest.get('head_revision') != 'sha256:' + expected['head.json']
                or manifest.get('calibration_revision') != 'sha256:' + expected['calibration.json']):
            raise ValueError('Ruri contract/order or artifact revision mismatch')
    elif head.get('contract') is not None:
        raise ValueError('versioned head cannot be served under the legacy model contract')
    mode = head.get('modes', {}).get('A', {})
    weights, bias = mode.get('weights', []), mode.get('bias', [])
    if (len(weights) != len(labels) or len(bias) != len(labels)
            or any(not isinstance(row, list) or len(row) != 256 for row in weights)
            or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
                   for row in [*weights, bias] for v in row)):
        raise ValueError('invalid Ruri head shape/values')
    temperature = calibration.get('temperature')
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError('invalid calibration temperature')
    if set(head.get('eval_ids', [])) & (set(train) | set(cal)):
        raise ValueError('evaluation identities overlap fitting data')
    return manifest, head, calibration, labels, contract['public_model'] if contract else PUBLIC_MODEL
