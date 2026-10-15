# 日本語・ツール利用・応答時間の再比較キット

2026-10-15の68項目を固定し、LFMの派生版、Strata版、MTP対応版、fine-tune、他モデルにも使う。
今回の判断は**載せ換え見送り、Ornith 1.5 STRIXを維持、LFMは再評価候補として保留**。
off再測定後も利用者は現行STRIXに十分満足しており、発売直後のLFMへ移行するほどの優位点はないと判断した。
再評価の契機はツール利用の追加学習モデルと、MTP・量子化・STRATAの進展とする。
将来の派生版・MTPの利用可能性や性能を確認済みという意味ではない。

- 同じreasoning off条件での再測定: [records/2026-10-15-reasoning-off.md](records/2026-10-15-reasoning-off.md)
- 再測定の比較値: [baselines/2026-10-15-reasoning-off.json](baselines/2026-10-15-reasoning-off.json)
- 初回の測定記録: [records/2026-10-15.md](records/2026-10-15.md)（LFMだけreasoning on。off同士の速度順位には使わない）
- 初回の比較値: [baselines/2026-10-15.json](baselines/2026-10-15.json)
- 詳細なSpec HTML: [評価結果](../../specs/lfm25-24b-local-evaluation-2026-10-15.html)
- 生応答・ログ: `/srv/ai/evidence/lfm25-24b-20261015`（repository外）

Python 3.10以上の標準ライブラリのみ。エンジンと取得済み重みはrepository外に置く。
評価は架空の文書・予定・ツール結果だけを使い、実際のツールを実行しない。

## 次回の実行

repositoryのrootから、既存の評価用LFMで再実行する例:

```sh
python3 benchmarks/lfm25/run.py \
  --engine /srv/ai/apps/larm-chat-input-engine-20261013/llama-server \
  --weights /srv/ai/models/lfm25-24b-a2b/LFM2.5-24B-A2B-QAD-Q4_0.gguf \
  --label 'LFM2.5 QAD Q4_0 再試験' \
  --thinking off \
  --output-dir /srv/ai/evidence/lfm25-new-trial \
  --diagnostics
```

新しい候補では`--weights`と`--label`、必要なら`--engine`を差し替える。
Gemma・Ornithの既存会話構成を比較するときは`--thinking off`を明示する。
`off`は起動引数の`--reasoning off --reasoning-budget 0`と要求の`enable_thinking: false`を併用する。
フラグだけではLFMのtemplateが思考を続けたため、短い事前検査で思考欄・thinkタグ・本文完了を確認する。
事前検査に失敗した場合は本試験を開始しない。通過後も全87応答を監査し、漏出を観測した場合は
生応答を保持して`reasoningOffVerified: false`と警告をmanifestに保存する。
LFMの予算0試験では、思考欄は空でも8応答に本文のthinkタグが残った。
この構成は「off要求・予算0」であり、思考由来の文が完全に消えることを保証しない。
`--dry-run`を追加すると起動予定だけを表示し、サーバーも推論も開始しない。
出力先は毎回新しい絶対パスを指定する。既存directoryやsource repository内への出力は拒否する。

runnerは空いているloopback portを選び、独立したサーバーを起動する。
`/props`のモデルと一意なaliasを確認してから評価し、正常終了・エラー・中断時に自身が起動したプロセスを終了する。
LARMのProfile、route、systemd、既存Providerの切替は行わない。
同時に複数の候補を起動すると資源競合で速度比較が変わるため、候補は順番に測る。

初期設定はVulkan0・全層offload・F16 K/V・4 slots・合計65536 context（各16384）。
5K程度の履歴＋最大4096出力に余裕を持たせる。
**初回の短入力・68項目・4会話は各8192枠だったため、保存済みの比較値とは容量条件が異なる。**
初回の再現は`--context 32768`で行えるが、履歴付きでLFMが枠を使い切ることが分かっている。
次の採用比較は候補と現行STRIXを同じ設定で再実行し、古いbaselineだけで優劣を確定しない。
他のGPU/backendは`--device`・`--gpu-layers`で明示する。

## Strata・MTPなどの追加設定

使用するエンジンが対応する追加引数を、JSON配列のファイルに保存して渡す。

```sh
python3 benchmarks/lfm25/run.py \
  --engine /srv/ai/apps/NEW-ENGINE/llama-server \
  --weights /srv/ai/models/NEW-MODEL/model.gguf \
  --label '候補名・量子化・MTP設定' \
  --thinking on \
  --extra-args-file /srv/ai/evidence/candidate-args.json \
  --output-dir /srv/ai/evidence/new-candidate-trial \
  --diagnostics
```

`candidate-args.json`の形式は`["--option", "value"]`。shellとして実行しない。
モデル・alias・port・host・context・slot数など、runner管理下の条件の上書きは拒否する。
draft重みなどの追加資材もrepository外に置く。
MTPの対応・適切な引数・利用条件は候補ごとに確認し、存在しない支援モデルやフラグを推測しない。
実際のargv、engineのversionとSHA-256、重みのpath・容量・更新時刻をmanifestへ残す。
重みの完全照合が必要なときは`--expected-model-sha256 HEX`を指定する。

## 出力

| ファイル | 内容 |
|---|---|
| `manifest.json` | 候補名、起動条件、資材情報、状態、終了確認 |
| `reasoning-preflight.json` | off要求時の事前応答と検証結果 |
| `evaluation.json` | 固定68項目、短入力・履歴各3回、4会話×3回の生応答・思考・timings |
| `summary.json` | 集計値。本文未完了や打切りも件数として保持 |
| `comparison.md` | off候補は同日off再測定、on候補は初回との比較表。条件差・本文長・人手確認項目 |
| `server.log` / `evaluate.log` / `props.json` | エンジンの互換性・実行条件の証跡 |

`--diagnostics`では、さらに次を保存する。

- `schema-none.json`: schema 6問に`tool_choice: "none"`を明示した追試。
- `japanese-seeds.json`: 「ねぎらい」をseed 0/1/2で追試。意味の正しさを人手で読む。
- `schema-default-seeds.json`: `schema-0`を既定条件でseed 0/1/2追試。
- `native-speed.json`: 固定512 token入力・128 token生成をwarmup後3回。

`complete`は必要な試験が実行されたことを表し、モデルの採用合格を意味しない。
`preflightReasoningOffVerified`は事前検査、`reasoningAudit`と`reasoningOffVerified`は本試験全体の確認結果。
再測定最初のLFM manifestは事前検査だけを記録した版なので、同測定の外部`audit-all.json`を全体監査の正本とする。
エラー・打切りを除外して速い値だけを残さず、件数とともに確認する。

## 保存済み結果だけで比較表を作る

```sh
python3 benchmarks/lfm25/report.py \
  --baseline benchmarks/lfm25/baselines/2026-10-15-reasoning-off.json \
  --input /srv/ai/evidence/new-candidate-trial/evaluation.json \
  --output /srv/ai/evidence/new-candidate-comparison.md
```

推論は行わない。複数の`--input`を渡せる。
初回の履歴baselineは、容量を各16384に広げた追試の値を収録している。
初回の各8192枠で打ち切られた履歴値を混ぜない。

既に自分で起動した独立サーバーへ、保存済み要求を再送する場合:

```sh
python3 benchmarks/lfm25/replay.py \
  --base-url http://127.0.0.1:18090 \
  --model YOUR-SERVER-ALIAS \
  --input /srv/ai/evidence/new-candidate-trial/evaluation.json \
  --case no-tool-5 --seed 0 --seed 1 --seed 2 \
  --output /srv/ai/evidence/new-candidate-replay.json
```

`--case history`は保存済み3反復を再送する。起動済みサーバーの枠は各16384以上を推奨する。
JSONだけの追試には`--case schema-0 --tool-choice none`を使える。
ツール使用の正答率を測る試験で`none`を強制して、不必要な呼出しの失敗を隠さない。

## 比較前に読む点

- `evaluate.py`はSHA-256を固定したv1。設問や採点を変える場合は別versionとして保存する。
- 68項目の自動判定は「ねぎらい→ネギ」の意味の誤りを検出しきれない。本文と失敗例を読む。
- 本文開始、総生成速度、思考込みtoken数、4会話の完了時間を別々に比較する。
- 同じ指示でも出力文字数は違う。4会話完了時間には本文長を併記し、等量生成の速度とは区別する。
- grammarのエラーを、モデルの文字化け・日本語理解の問題と混同しない。
- 本番の256K各会話・1M pool、画像対応、ASR/TTS同時負荷、実業務全tool、長時間soakは別の受入条件。
- 今回の載せ換え見送りは記録済み。将来の再測定も本番切替の操作とは別に行う。

資材の検査（モデルを起動しない）:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s benchmarks/lfm25 -p 'test_*.py'
```
