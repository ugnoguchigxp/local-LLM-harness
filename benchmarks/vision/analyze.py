"""Summarize evidence without turning a small pilot into a production pass."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--baseline', default='baseline-clean.json')
    parser.add_argument('--florence', default='florence-upstream.json')
    parser.add_argument('--table', default='table-fixed.json')
    parser.add_argument('--docling', default='docling-main.json')
    parser.add_argument('--d1', default='d1-main.json')
    args = parser.parse_args()
    root = args.evidence
    fixtures = {f['id']: f for f in json.loads((root / 'fixtures' / 'manifest.json').read_text())['fixtures']}
    selected = [args.baseline, args.florence, args.table, args.docling, args.d1]
    summary = {'scope': '11 exploratory fixtures; synthetic documents and two familiar demonstration photos',
               'adoption': 'not production-qualified; workload thresholds and representative data remain open',
               'runs': {}, 'table_checks': [], 'document_checks': []}
    for name in selected:
        path = root / name
        if not path.exists():
            summary['runs'][name] = {'missing': True}
            continue
        run = json.loads(path.read_text())
        summary['runs'][name] = {key: run.get(key) for key in
            ['complete', 'errors', 'load_ms', 'load_and_warmup_ms', 'warm', 'peak_process_rss_mib', 'torch', 'transformers', 'dtype']}
        summary['runs'][name]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        if run['stage'] == 'table':
            for observation in run['observations']:
                expected = fixtures[observation['fixture']]['expected']
                if 'rows' not in expected:
                    continue
                grid = observation.get('oracle_grid', {})
                check = {'fixture': observation['fixture'], 'rows_match': grid.get('rows') == expected['rows'],
                         'columns_match': grid.get('columns') == expected['columns'],
                         'merged_match': grid.get('merged') == expected['merged']}
                for field in ['oracle_grid', 'ocr_grid']:
                    if field in observation and 'cells' in expected:
                        actual = {(c['row'], c['column']): c['text'] for c in observation[field]['cells']}
                        correct = sum(actual.get((c['row'], c['column'])) == c['text'] for c in expected['cells'])
                        check[field + '_exact_cells'] = {'correct': correct, 'total': len(expected['cells'])}
                summary['table_checks'].append(check)
        if run['stage'] == 'docling':
            from PIL import Image
            from docling_core.types.doc import DoclingDocument
            from docling_core.types.doc.document import DocTagsDocument
            for observation in run['observations']:
                if observation['task'] != 'document':
                    continue
                fixture = fixtures[observation['fixture']]
                raw = observation['output']['raw']
                check = {'fixture': fixture['id'], 'at_token_limit': observation['output']['at_token_limit']}
                try:
                    image = Image.open(fixture['path']).convert('RGB')
                    tags = DocTagsDocument.from_doctags_and_image_pairs([raw], [image])
                    document = DoclingDocument.load_from_doctags(tags, document_name=fixture['id'])
                    markdown = document.export_to_markdown()
                    out = root / (fixture['id'] + '-docling.md')
                    out.write_text(markdown)
                    check['parse_ok'] = True
                    check['markdown_path'] = str(out)
                    check['tables'] = len(document.tables)
                    expected_cells = fixture['expected'].get('cells')
                    if expected_cells and document.tables:
                        data = document.tables[0].data
                        actual = {(c.start_row_offset_idx, c.start_col_offset_idx): c.text for c in data.table_cells}
                        check['exact_cells'] = {'correct': sum(actual.get((c['row'], c['column'])) == c['text'] for c in expected_cells),
                                                'total': len(expected_cells)}
                    if 'text_contains' in fixture['expected']:
                        check['expected_text_presence'] = {text: text in markdown for text in fixture['expected']['text_contains']}
                except Exception as error:
                    check['parse_ok'] = False
                    check['error'] = repr(error)
                summary['document_checks'].append(check)
    (root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
