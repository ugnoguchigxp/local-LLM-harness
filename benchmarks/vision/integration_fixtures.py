"""Additional cases and answer keys; runtime chains never read this manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--opencv-samples', type=Path)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('fixtures must stay outside the source repository')
    args.output.mkdir(parents=True, exist_ok=False)
    prior = json.loads((args.previous/'fixtures'/'manifest.json').read_text())
    previous = {f['id']: f for f in prior['fixtures']}
    font_path = prior['font']['path']
    font = ImageFont.truetype(font_path, 27)
    title_font = ImageFont.truetype(font_path, 34)
    cases = []

    def add(name, image, objective, expected, split='evaluation', origin='generated synthetic case', exif=False, input_kind='auto'):
        path = args.output/(name+('.jpg' if exif else '.png'))
        if exif:
            image = image.rotate(90, expand=True)
            metadata = Image.Exif()
            metadata[274] = 6
            image.save(path, exif=metadata, quality=95)
        else:
            image.save(path)
        cases.append({'id': name, 'path': str(path), 'objective': objective, 'expected': expected, 'input_kind': input_kind,
                      'split': split, 'source': origin, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})

    def table(values, merged=False, color='black'):
        widths = [280, 180, 220, 200][:len(values[0])]
        xs = [20]
        for width in widths:
            xs.append(xs[-1]+width)
        ys = [20+i*85 for i in range(len(values)+1)]
        image = Image.new('RGB', (xs[-1]+20, ys[-1]+20), 'white')
        draw = ImageDraw.Draw(image)
        for y in ys:
            draw.line((xs[0], y, xs[-1], y), fill=color, width=2)
        for i, x in enumerate(xs):
            draw.line((x, ys[1] if merged and i == 1 else ys[0], x, ys[-1]), fill=color, width=2)
        for ri, row in enumerate(values):
            for ci, text in enumerate(row):
                draw.text((xs[ci]+15, ys[ri]+23), text, font=font, fill=color)
        return image

    en = [['Code', 'Qty', 'Price'], ['A1', '0012', '100'], ['B2', '0', ''], ['C3', '7', '=1+2']]
    ja = [['商品', '数量', '金額'], ['りんご', '12', '100'], ['みかん', '5', '80'], ['合計', '17', '180']]
    simple_en, simple_ja = table(en), table(ja)
    add('calibration-table', simple_en, 'table', {'status': 'ready', 'tables': [en], 'supported': True}, 'calibration')
    add('calibration-white', Image.new('RGB', (640, 480), 'white'), 'table', {'status': 'empty'}, 'calibration')

    def page(tab, japanese=False):
        image = Image.new('RGB', (1100, 1000), 'white')
        draw = ImageDraw.Draw(image)
        draw.text((65, 45), '在庫表' if japanese else 'Inventory report', font=title_font, fill='black')
        draw.text((65, 110), '確認日 2026-10-18' if japanese else 'Checked on 2026-10-18', font=font, fill='black')
        image.paste(tab, (80, 220))
        draw.text((65, 820), '備考：数量を確認しました。' if japanese else 'Note: counts have been checked.', font=font, fill='black')
        return image

    add('page-en', page(simple_en), 'table', {'status': 'ready', 'tables': [en], 'supported': True})
    add('page-ja', page(simple_ja, True), 'table', {'status': 'ready', 'tables': [ja], 'supported': True})
    literal = [['Name', 'ID', 'Count', 'Value'], ['Alpha', '0007', '0', '=2+3'], ['Beta', '0042', '', '-001']]
    add('literal-values', table(literal), 'table', {'status': 'ready', 'tables': [literal], 'supported': True})
    empty = [['Item', 'Count', 'Memo'], ['Desk', '', ''], ['Chair', '3', 'OK']]
    add('empty-cells', table(empty), 'table', {'status': 'ready', 'tables': [empty], 'supported': True})
    multi = Image.new('RGB', (1100, 1200), 'white')
    multi.paste(simple_en, (70, 50))
    multi.paste(simple_ja, (110, 650))
    add('two-tables', multi, 'table', {'status': 'ready', 'tables': [en, ja], 'supported': True})
    add('exif-rotation', simple_ja, 'table', {'status': 'ready', 'tables': [ja], 'supported': True}, exif=True)
    merged_values = [['Inventory', '', '2026'], ['Item', 'Qty', 'Price'], ['Apple', '12', '100'], ['Pear', '5', '80']]
    add('merged-header', table(merged_values, merged=True), 'table', {'not_ready': True, 'tables': [merged_values]}, split='regression')
    add('low-contrast-table', table(ja, color=(225, 225, 225)), 'table', {'not_empty': True, 'tables': [ja]}, split='stress')
    add('blurred-table', page(simple_ja, True).filter(ImageFilter.GaussianBlur(1.7)), 'table', {'not_empty': True, 'tables': [ja]}, split='stress')
    add('skewed-table', simple_en.rotate(4, expand=True, fillcolor='white'), 'table', {'not_empty': True, 'tables': [en]}, split='stress')
    for name, color in [('white', 'white'), ('black', 'black'), ('gray', (190, 190, 190))]:
        add('empty-'+name, Image.new('RGB', (640, 480), color), 'describe', {'status': 'empty', 'model_calls': 0})
    tiny = Image.new('RGB', (1600, 1000), 'white')
    ImageDraw.Draw(tiny).text((20, 20), '小さい文字 0012', font=ImageFont.truetype(font_path, 14), fill=(210, 210, 210))
    add('sparse-light-text', tiny, 'describe', {'not_empty': True, 'no_scene_caption': True})
    prose = Image.new('RGB', (1000, 800), 'white')
    draw = ImageDraw.Draw(prose)
    for i, text in enumerate(['利用案内', 'この画像には文章だけが書かれています。', '表の構造や数式は含まれていません。', '番号 0012 を確認してください。']):
        draw.text((45, 40+90*i), text, font=font, fill='black')
    add('prose-no-table', prose, 'table', {'not_ready': True, 'tables': []})
    add('prose-describe', prose, 'describe', {'no_scene_caption': True, 'not_empty': True})
    for name in ['car', 'bus']:
        with Image.open(previous[name]['path']) as image:
            add('photo-'+name, image.convert('RGB'), 'describe', {'status': 'ready', 'keyword': name},
                split='regression', origin=previous[name]['source'])
    for name in ['formula-pythagoras', 'formula-quadratic', 'document-mixed-en', 'document-mixed-ja']:
        with Image.open(previous[name]['path']) as image:
            add(name, image.convert('RGB'), 'formula' if name.startswith('formula') else 'document',
                {'status': 'needs_review', 'latex': previous[name]['expected'].get('latex')},
                split='regression', origin='prior corpus '+previous[name]['sha256'])
    add('judge-table', simple_ja, 'judge', {'table': True, 'formula': False}, split='regression')
    with Image.open(previous['formula-pythagoras']['path']) as image:
        add('judge-formula', image.convert('RGB'), 'judge', {'table': False, 'formula': True}, split='regression')
    bad = args.output/'corrupt.png'
    bad.write_bytes(b'not an image')
    cases.append({'id': 'corrupt-image', 'path': str(bad), 'objective': 'table', 'split': 'evaluation',
                  'expected': {'status': 'failed', 'model_calls': 0}, 'source': 'synthetic malformed input',
                  'sha256': hashlib.sha256(bad.read_bytes()).hexdigest()})
    if args.opencv_samples:
        revision = subprocess.check_output(['git', '-C', str(args.opencv_samples), 'rev-parse', 'HEAD'], text=True).strip()
        for filename, keywords in [('orange.jpg', ['orange']), ('fruits.jpg', ['fruit', 'orange', 'lemon']),
                                   ('graf1.png', ['graffiti', 'mural', 'painting'])]:
            source = args.opencv_samples/filename
            for kind in ['auto', 'photo']:
                with Image.open(source) as image:
                    add('opencv-'+source.stem+'-'+kind, image.convert('RGB'), 'describe',
                        {'status': 'ready', 'keywords_any': keywords}, split='public',
                        origin='opencv '+revision+' samples/data/'+filename, input_kind=kind)
        with Image.open(args.opencv_samples/'notes.png') as image:
            add('opencv-music-table', image.convert('RGB'), 'table', {'not_ready': True, 'tables': []},
                split='public', origin='opencv '+revision+' samples/data/notes.png')
            add('opencv-music-describe', image.convert('RGB'), 'describe', {'no_scene_caption': True, 'not_empty': True},
                split='public', origin='opencv '+revision+' samples/data/notes.png')
    (args.output/'manifest.json').write_text(json.dumps({'cases': cases,
        'scope': 'synthetic additions and known-photo regressions; not representative field data',
        'font_sha256': prior['font']['sha256'], 'source_manifest_sha256': hashlib.sha256((args.previous/'fixtures'/'manifest.json').read_bytes()).hexdigest()},
        ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'cases': len(cases), 'manifest': str(args.output/'manifest.json')}))


if __name__ == '__main__':
    main()
