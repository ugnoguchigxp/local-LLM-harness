# LFM2.5・STRIX・Gemma：reasoning off再測定

測定日: **2026-10-15（JST）**。利用者の「reasoning offでないとフェアでない」という指摘を受け、3モデルすべてを再測定した。稼働中のProviderやProfileは変更していない。載せ換え見送りの状態を維持する。

## 再測定後の利用者判断

現行Ornith 1.5 STRIXで十分満足しているため継続する。LFMはoff時の本文開始・4会話完了が速いという結果を踏まえても、発売直後に移行するほどの優位点ではないと判断した。
ツール利用の追加学習モデルが利用可能になった際に再検討し、MTP・量子化・STRATAの進展も再評価の契機とする。
将来の改善を確認済みとはせず、同条件の測定結果と失敗例を次回の比較基準として保持する。

## 結論と初回記録の訂正

初回はLFMだけreasoning on・推論専用予算なし、他2モデルはoffだった。初回の「4会話で約15倍遅い」をoff同士の性能差として扱うのは不適切だった。
今回のLFMはoff要求・予算0で4会話完了が中央値2.304秒となり、初回67.904秒から大幅に短縮した。ただし初回とはcontext枠も8Kから16Kへ変わっているので、差の全量をreasoningだけに厳密に帰属させる対照実験ではない。初回ログでは大量の思考token生成が主因と分かっていた。

新しい3モデルの比較は同じcontext・推論設定で実施した。LFMは待ち時間の弱点が改善した一方、本文への思考文混入とツール引数・日本語の意味の誤りが残る。off要求だけでは思考由来の文章が完全に消えたとは言えない。

## 測定結果

速度・時間は各3回の中央値。4会話は3組・計12応答。ツール判定は固定模擬課題であり、実業務や一般benchmarkの正答率ではない。

| 指標 | LFM2.5 QAD | Ornith 1.5 STRIX | Gemma 4 QAT |
|---|---:|---:|---:|
| 短入力decode（tok/s） | 94.01 | 60.03 | 52.53 |
| 短入力の本文開始（秒） | 0.314 | 0.392 | 0.331 |
| 短入力の完了（秒） | 5.286 | 5.955 | 4.708 |
| 4会話すべて完了（秒） | 2.304 | 5.224 | 4.581 |
| 4会話・1応答の本文文字数 | 103.0 | 228.5 | 197.0 |
| 4会話・1応答の生成token数 | 67.5 | 107.5 | 101.0 |
| ツール関連45判定 | 41/45 | 44/45 | 42/45 |
| 基本ツール引数18問 | 16/18 | 17/18 | 15/18 |
| 文字列の完全保持8問 | 7/8 | 8/8 | 8/8 |
| 指示だけでJSONの値・形式一致 | 5/6 | 1/6 | 0/6 |
| json_schema指定の値・形式一致 | 2/6 | 6/6 | 6/6 |
| 履歴付き完了（秒） | 9.196 | 11.596 | 10.633 |
| 履歴付き正常完了 | 3/3 | 3/3 | 3/3 |
| 専用思考欄が非空 | 0 | 0 | 0 |
| 本文にthinkタグが残る応答 | 8 | 0 | 0 |

4会話の固有符号は全モデル12/12保持、全3組完了。LFMの本文長中央値103文字に対しSTRIXは228.5文字で、約200文字という指示への追従に差がある。したがって2.304秒という完了時間を「同じ量の文章を他モデルの半分以下の時間で生成」とは解釈しない。

## offをどう確認したか

1. 起動時は全モデルで`--reasoning off --reasoning-budget 0 --reasoning-format deepseek`。
2. 各要求で`chat_template_kwargs.enable_thinking: false`。全応答の最大出力は4096 token。
3. 短い「準備完了」の事前応答で、思考欄が空、thinkタグなし、本文あり、正常終了を確認。
4. 固定試験の87応答（warmup 1・判定68・性能6・4会話12）を事後監査。

予算0を付けない最初のoff試行では、LFMが思考を継続したため中止した。LFMのtemplateと本エンジンでは`enable_thinking: false`や`--reasoning off`だけで生成停止を保証できない。予算0ではserver.logに`budget=0, forcing immediately`を確認した。

予算0の全モデルで専用思考欄は87/87空。ただしLFMは8応答の本文に`</think>`が残り、`copy-3`では長い自己検討文も出た。試験を通過した事前確認だけで全体をoff検証済みとはしない。STRIX・Gemmaの全体監査は別表のとおり。

最初に完了したLFMのmanifestは事前検査だけを`reasoningOffVerified: true`と記録した版である。生証跡は改変せず、全試験の正しい判定を外部の`audit-all.json`に保存した。現行runnerは事前検査と全体監査を分け、後者で漏出したとき`reasoningOffVerified: false`にする。

## 品質と互換性の観察

- LFMのツール関連は41/45（初回on時44/45）。`search-1/2`でqueryへJSON全体を文字列として入れた。東京・大阪の並列取得では指定の日本語をTokyo・Osakaへ変えた。入力値の厳密保持として不合格にした。
- LFMの「今日は疲れました。ねぎらいを一言。」は、本文でねぎを切る説明に誤解し、前後で同文を重複した。自動判定は不要なツール呼出しだけを見るため6/6に含まれてしまう。seed 0/2は励ましを返すがタグと重複が残り、seed 1は不要なツールを呼んだ。一般会話の意味評価は人手確認が必要。
- STRIXの同じseed追試では励ましの意味は保たれたが、「くつろいTime」のような混在表記もあった。文字化け検知の合格は自然な日本語の保証ではない。
- LFMのjson_schemaは2/6。残り4件はserver_error（code 500）で、server.logにはgrammar parseの失敗がある。同じ古いforkでのLFM2.5テンプレート・grammar互換性問題が関与しており、この値だけでモデル固有のJSON能力を断定しない。
- ツールを与えていないschema要求に限り`tool_choice: none`を付けた追試は、下記のとおり。ツール正答率の試験にはnoneを付けていない。LFMではschema-0が部分JSONの後に500となり、予算0での万能な回避策にはならなかった。
- 全87応答でUFFFD置換文字、想定外制御文字、既定の文字化けパターン、長い連続反復パターンの検出は0。LFMのタグ漏出8件と、短い文の重複・意味誤りは別に記録する。
- 散文3/3は文字数と破損パターンだけの機械判定。技術説明の正しさや日本語の意味は採点していない。小規模・単一の主seedのため、実業務への一般化や統計的な優越性は示さない。

| 追加診断 | LFM | STRIX | Gemma |
|---|---:|---:|---:|
| schema＋tool_choice none（値も一致） | 5/6 | 5/6 | 6/6 |
| native 512入力・128生成（tok/s、中央値） | 93.11 | 60.71 | 52.90 |

native測定は各tokenizerで512個の入力tokenを切り出し、ignore_eosで128個出力したdecodeの参考値。chatの文章量や日本語の品質を揃えた試験ではない。

## 再現条件と証跡

CPU/GPU: Ryzen AI MAX+ 395。共通engineはROCmFPX b244、revision `0fc9568e07ccc8553010864cb8db1957e629cbfa`。SHA-256 `d7b699c6d8c051b54e357d730940647ff8331d11e7543e38c96921a6c09fc1bb`。

- Vulkan0、全層offload、Flash Attention on、fit off、K/VともF16。
- 合計context 65536、4 slots、各16384。batch 2048、ubatch 512、threads 16。
- temperature 0.1、top_k 50、top_p 1、min_p 0、repeat_penalty 1.05、seed 20261015、cache_prompt false。
- 重みは初回と同じLFM QAD Q4_0（13,578,190,880 bytes）、Ornith STRIX_LEAN ROCmFP4（19,052,439,552 bytes）、Gemma IT QAT Q4_0（14,439,363,584 bytes）。Ornithは画像projectorなしのテキスト評価。
- 各モデルは独立した一意のalias・loopback portで順番に起動。既存のLARM Providerは維持したため、完全に専用の無負荷機ではない。ASR/TTSを同時駆動した負荷試験ではない。
- frozen `evaluate.py` SHA-256 `84f958d16035c4ea7892107f667e409840137b3adecc8a249cfd32fd75d54465`。モデル固有の生成履歴を除き、設問・固定tool履歴・tool定義・schema・sampling条件が全モデル一致することを保存要求から照合した。

生証跡: `/srv/ai/evidence/lfm25-reasoning-off-20261015`。各`*-off-verified/`内に起動manifest、評価生JSON、事前応答、server.log、props、seed追試、schema追試、native測定を保持。directory名のverifiedは全応答の無漏出保証ではなく、必ず全体監査を見る。

全体監査は`audit-all.json`、再集計表は`comparison.md`。初期のoffフラグだけの中断試行は`lfm25/`に残した。重複起動を防いで出力先既存チェックで停止した制御試行は`run-remaining.log`に残るが測定値には含めない。

本番health・configRevision・releaseCommitを試験前後で照合し、評価用の全プロセス終了を確認した。既存Ornithは停止・再起動していない。Profileやrouteの変更はない。

## 次回に使う資材

[README](../README.md)の`--thinking off`で予算0と事前検査・全体監査を再利用する。比較値は[off baseline](../baselines/2026-10-15-reasoning-off.json)。[初回記録](2026-10-15.md)は条件の異なる履歴として保持する。設問・採点を変える場合はfrozen版を直接変更せずversionを分ける。

Strata、MTP、fine-tuneの新候補は利用可能性と実行条件を確認したうえで同じ試験にかける。本番への載せ換えや自動監視は今回行わない。
