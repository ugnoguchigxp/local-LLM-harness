"""Hand-authored synthetic pilot; NOT human-reviewed conversation evidence.

Tuple items are original spans (text, spoken language, terminal pause).
Conversation/template groups are disjoint across train/calibration/evaluation.
Partial inputs explicitly state the last complete safe span; no unseen text is
passed to inference. Ambiguous readings are fixed BEFORE evaluation.
"""


def row(split, group, spans, partials=(), context='', overrides=()):
    text = ''.join(s[0] for s in spans)
    result = dict(id=group, split=split, conversation_id=group,
                  template_group=group, text=text, spans=spans,
                  context=context, overrides=overrides, partials=partials)
    for prefix, committed in partials:
        assert text.startswith(prefix) and 0 <= committed <= len(prefix)
        endpoints = {0}
        offset = 0
        for span, _, _ in spans:
            offset += len(span)
            endpoints.add(offset)
        assert committed in endpoints
    return result


def corpus():
    ja = lambda text, pause='sentence': (text, 'ja', pause)
    en = lambda text, pause='sentence': (text, 'en', pause)
    return [
        row('train', 'settings', [ja('ログイン画面の ', 'none'), en('Stay signed in ', 'none'), ja('を有効にします。')]),
        row('train', 'mail', [ja('メールの ', 'none'), en('Reply all ', 'none'), ja('を押します。')], [('メールの Rep', 0)]),
        row('train', 'restart', [en('Please restart the computer.')], [('Please restart the comp', 0)]),
        row('train', 'quiet', [ja('静かな場所でお話しください。')], [('静かな場所でお話しくだ', 0)]),
        row('train', 'decimal', [ja('温度は3.14度です。')], [('温度は3.', 0)]),
        row('train', 'thousands', [ja('価格は1,200円、', 'short'), ja('送料は無料です。')], [('価格は1,2', 0), ('価格は1,200円、送料', 10)]),
        row('train', 'en-comma', [en('If you need help, ', 'short'), en('please call us.')], [('If you need help', 0)]),
        row('train', 'abbreviation', [en('Dr. Smith lives in the U.S.A.')], [('Dr.', 0), ('Dr. Smith lives in the U.S.', 0)]),
        row('train', 'web', [ja('URLはhttps://example.com/aです。')], [('URLはhttps://example.', 0)]),
        row('train', 'brackets', [ja('括弧内の ', 'none'), en('(read only) ', 'none'), ja('は編集不可という意味です。')], [('括弧内の (read', 0)]),
        row('train', 'numbers-en', [en('The file is 2.5 MB, ', 'short'), en('and the total is 1,024 bytes.')], [('The file is 2.', 0)]),
        row('train', 'no-punctuation-ja', [ja('最初に画面を開いて ', 'short'), ja('次に項目を選択して ', 'short'), ja('最後に内容を確認します', 'none')]),
        row('train', 'no-punctuation-en', [en('Open the settings panel ', 'short'), en('select your preferred theme ', 'short'), en('then save your changes', 'none')]),
        row('train', 'ascii-ja', [ja('CPUの使用率は20%です。')], context='CPUはシーピーユーと日本語で読みます。'),
        row('train', 'ascii-en', [en('CPU ', 'none'), ja('と英語で発音します。')], context='冒頭のCPUは英語で読みます。', overrides=((0, 3, 'en'),)),
        row('train', 'product-ja', [ja('Windowsを起動します。')], context='製品名はウィンドウズと日本語読み。'),
        row('train', 'product-en', [ja('製品名 ', 'none'), en('Windows ', 'none'), ja('を英語で読みます。')], overrides=((4, 11, 'en'),)),
        row('train', 'quote-en', [ja('表示は ', 'none'), en('"Try again" ', 'none'), ja('です。')]),
        row('train', 'two-ja', [ja('準備できました。'), ja('それでは始めましょう。')]),
        row('train', 'two-en', [en('Everything is ready.'), en('Let us begin.')]),
        row('train', 'short-ja', [ja('はい。')], [('は', 0)]),
        row('train', 'short-en', [en('Yes.')], [('Ye', 0)]),
        row('train', 'unknown-tail', [ja('これはテスト', 'none')], [('これはテ', 0)]),
        row('train', 'units', [ja('距離は5km、', 'short'), ja('時間は10分です。')]),
        row('calibration', 'navigate', [ja('メニューの ', 'none'), en('Save as ', 'none'), ja('を選択します。')], [('メニューの Save a', 0)]),
        row('calibration', 'request-help', [en('Could you help me, ', 'short'), en('please?')], [('Could you help', 0)]),
        row('calibration', 'fraction', [ja('割合は0.75です。')], [('割合は0.', 0)]),
        row('calibration', 'cal-url', [ja('参照先はhttps://test.org/xです。')]),
        row('calibration', 'notice', [ja('内容を保存して ', 'short'), ja('画面を閉じます', 'none')]),
        row('calibration', 'sdk', [ja('SDKを追加します。')], context='SDKはエスディーケーと日本語で読む。'),
        row('calibration', 'professor', [en('Prof. Brown arrived at 9.30 a.m.')], [('Prof.', 0)]),
        row('calibration', 'pending-cal', [en('Wait for the next message', 'none')], [('Wait for the nex', 0)]),
        row('evaluation', 'user-example', [ja('設定画面で ', 'none'), en('Keep me signed in ', 'none'), ja('を選んでください。')],
            [('設定画面で Keep me signed i', 6)]),
        row('evaluation', 'download', [ja('ボタンの ', 'none'), en('Download now ', 'none'), ja('を押してください。')], [('ボタンの Downloa', 0)]),
        row('evaluation', 'japanese-only', [ja('今日はよい天気です。'), ja('公園を歩きましょう。')]),
        row('evaluation', 'english-only', [en('The meeting starts tomorrow.'), en('Bring your notes.')]),
        row('evaluation', 'eval-decimal', [ja('測定値は12.34、', 'short'), ja('合計は9,876です。')], [('測定値は12.', 0)]),
        row('evaluation', 'eval-abbrev', [en('Ms. Green works for Acme Inc.')], [('Ms.', 0), ('Ms. Green works for Acme I', 0)]),
        row('evaluation', 'eval-link', [ja('リンクはhttps://docs.example.net/v1.2?q=aです。')]),
        row('evaluation', 'eval-quote', [ja('引用 ', 'none'), en('"Good morning, everyone." ', 'none'), ja('の発音を確認します。')], [('引用 "Good mor', 0)]),
        row('evaluation', 'eval-parens', [ja('説明 ', 'none'), en('(optional) ', 'none'), ja('も読んでください。')]),
        row('evaluation', 'eval-acronym-ja', [ja('GPUを交換してください。')], context='GPUはジーピーユーと日本語で読んでください。'),
        row('evaluation', 'eval-acronym-en', [en('GPU ', 'none'), ja('を英語で読んでください。')], overrides=((0, 3, 'en'),)),
        row('evaluation', 'eval-brand', [ja('GitHubで共有します。')], context='GitHubはギットハブと日本語で読む。'),
        row('evaluation', 'eval-units', [en('It weighs 1.5 kg, ', 'short'), en('about 3.3 lb.')]),
        row('evaluation', 'eval-long-ja', [ja('まず必要な資料を集めて ', 'short'), ja('全体を確認してから ', 'short'), ja('手順を順番に進めてください', 'none')]),
        row('evaluation', 'eval-long-en', [en('Check the connection ', 'short'), en('open your browser ', 'short'), en('and visit the home page', 'none')]),
        row('evaluation', 'eval-short', [en('OK', 'none')], [('O', 0)]),
        row('evaluation', 'eval-unicode', [ja('👩🏽‍💻とe\u0301を表示します。')]),
        row('evaluation', 'eval-incomplete', [ja('未完成の説明', 'none')], [('未完成の', 0)]),
    ]
