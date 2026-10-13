"""Fresh 25 Japanese + 25 English test sentences, never used to fit a head.

Authored after the 400-example model was frozen. No romanized Japanese.
The original 200-example evaluation is preserved as an earlier experiment.
"""
import json
from pathlib import Path
from corpus import rows as earlier_rows

PAIRS = {
    'signage': '''
入口の札には「Welcome」と書かれていました。 | The card at the entrance had the word "Welcome" on it.
こちらが出口です。 | This is the exit.
注意書きが小さくて読みにくいです。 | The notice is too small to read comfortably.
案内板の矢印は階段の方向を示しています。 | The arrow on the information board points toward the stairs.
看板の「Closed」は閉店中という意味です。 | The word "Closed" on the sign means the shop is not open.
''',
    'construction': '''
足場を外すと建物の全体が見えるようになりました。 | Removing the scaffolding revealed the entire building.
作業員が長さを確かめてから板を切りました。 | The worker checked the length before cutting the board.
壁を塗り直すために周りをシートで覆っています。 | We are covering the surrounding area with sheets to repaint the wall.
工事の音が昼過ぎには聞こえなくなりました。 | The construction noise could no longer be heard by early afternoon.
通路に置かれた資材を別の場所へ移しました。 | We moved the materials left in the passage to another place.
''',
    'folktale': '''
旅人は道端で拾った石を大切に持ち歩いていました。 | The traveler treasured a stone found beside the road and carried it along.
夜が明けると森の向こうに小さな村が見えました。 | At dawn, a small village appeared beyond the forest.
王様は返事を聞くまで黙ったままでした。 | The king remained silent until he heard the answer.
古い扉の奥から誰かの笑い声が響きました。 | Someone's laughter echoed from behind the old door.
二人は橋の上で別れ、それぞれの道へ進みました。 | The two parted on the bridge and continued along their separate paths.
''',
    'payments': '''
レシートに同じ商品が二回記載されていました。 | The same item was listed twice on the receipt.
合計は980円でした。 | The total was 980 yen.
お釣りを受け取ってから袋を持ち上げました。 | I picked up the bag after receiving my change.
カードの支払いを取り消して現金で払いました。 | I canceled the card payment and paid in cash.
表示された金額と請求された金額が一致していました。 | The displayed amount matched the amount charged.
''',
    'spatial-description': '''
箱の右側に赤い円があります。 | There is a red circle on the right side of the box.
細い線が図形の真ん中を横切っています。 | A thin line crosses the center of the shape.
上にあります。 | It is above.
左から二番目の形だけ向きが違います。 | Only the second shape from the left faces a different direction.
重なった部分を除くと三つの領域に分かれます。 | Excluding the overlapping part leaves three separate regions.
''',
}


def rows():
    result = []
    for group, source in PAIRS.items():
        for index, line in enumerate(source.strip().splitlines()):
            pair = line.strip().split(' | ')
            if len(pair) != 2:
                raise ValueError('invalid bilingual test pair')
            conversation = f'fresh-{group}-{index + 1:02d}'
            for language, text in zip(['ja', 'en'], pair):
                result.append(dict(id=conversation + '-' + language, split='evaluation50',
                                   conversation_id=conversation, template_group=group,
                                   language=language, text=text, synthetic=True))
    return result


def validate(data):
    old = earlier_rows()
    for field in ['id', 'conversation_id', 'template_group', 'text']:
        previous = {r[field] for r in old}
        if any(r[field] in previous for r in data):
            raise ValueError('fresh evaluation overlaps earlier corpus: ' + field)
    if len(data) != 50 or len({r['id'] for r in data}) != 50 or len({r['text'] for r in data}) != 50:
        raise ValueError('expected 50 unique fresh tests')
    if {language: sum(r['language'] == language for r in data) for language in ['ja', 'en']} != {'ja': 25, 'en': 25}:
        raise ValueError('expected 25 tests per language')


if __name__ == '__main__':
    data = rows()
    validate(data)
    Path(__file__).with_name('evaluation50.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in data))
