# Ornith MTP 実機ベンチマーク

測定日: 2026-10-24 JST。対象はgnosisのRyzen AI MAX+ 395 / Radeon 8060S / 128 GB。

## 保留状況と再開条件

**2026-10-24、利用者の指示で実機検証を保留。背後でStrixの再起動検証が動いていたため、今回の数値はすべて参考記録とし、公平な性能比較・採用判断には使用しない。100 / 120 tok/sの達成可否、最速構成、品質の優劣は未判定。** 途中の完了試行も、この制約から除外しない。従前の速度に基づく移行非推奨の結論は撤回する。

今回用の検証プロセスが残っていないことを確認した。既存Eumenesと別の再起動検証には停止・再起動・設定変更を行っていない。モデル・エンジン・スクリプト・途中データを保存し、自動再開は設定しない。

再開時は、別の再起動検証と競合処理が終了したことを確認してから、空き資源、稼働構成、エンジン版を再確認する。今回の自動監視は全種類のバックグラウンド処理を検出できず、短時間のidleだけでは公平性を保証しない。新しい出力先でAから同条件のウォームアップ除外・各3回測定をやり直し、今回の値と平均しない。

保存した準備:

- 調査と互換性: `ornith-mtp-research.md`。CLIの実在確認と公開値の出典を含む。
- 手動再実行: `ornith-mtp-reproduce.sh`。引数なしでは説明だけを表示し、既存サービス停止・ドライバ更新・モデル削除は含まない。
- 独立エンジン・重み: `/srv/ai/apps/ornith-mtp-trial-20261024/`。hipfire v0.4.2.1 / commit `6b363a56a1ae28ed421178d3c7eba9f6f4bacbb5` のビルド、gfx1151 kernel、検証済みMQ4とMTP sidecarを保持。再ダウンロード不要。
- ROCmFPX準備: 同ディレクトリの `rocmfpx-v1.7.0/unpacked/strix-halo-rocmfpx-engine/bin/llama-server`。配布名v1.7.0、実際のCLI表示は0.3.0-dev / build11474 / commit75e67a92b。取得archiveのSHA-256は `19deedcaac6c13548be417dfaf5368c4b5eb8a9b3cdac3c9b4405b0f0e55d367`。R0 / R2Sで参照するが性能評価は保留。
- 途中データ: `/srv/ai/evidence/ornith-mtp-20261024/`。254行（成功206行にはwarmupを含む、安全中断48行）を集計CSVへ保存。全行を比較対象外とし、元CSV・response・telemetryは変更しない。保留状態を `deferred-state.json` に記録した。

## 保存した途中結果（比較判定に使用しない）

| 構成・run | 日本語会話N | 平均 tok/s | 中央値 | 最大 | TTFT中央値 ms | 短prompt prefill平均 tok/s | MTP採用数 / 候補数 |
|---|---:|---:|---:|---:|---:|---:|---|
| A 現行 / greedy / A-full | 3 | 67.92 | 67.95 | 68.17 | 235.4 | 317.6 | 対象外 |
| A 現行 / 温度0.6 / A-sampled-final | 3 | 67.85 | 67.84 | 67.89 | 228.7 | 318.8 | 対象外 |
| A1 現行重み・別process64K/1slot / A1-final | 3 | 65.92 | 65.86 | 66.10 | 231.5 | 318.0 | 対象外 |
| C0 更新済み重み・MTP無効 / C0-final | 3 | 67.39 | 67.70 | 67.70 | 229.2 | 323.1 | 対象外 |
| C2S 更新済み公式head・n2/p.6・strict-qwen / C2S-priority | 3 | 59.71 | 59.64 | 61.60 | 239.6 | 304.4 | 341 / 486、70.16% |
| E0 hipfire MQ4・AR / E0-final | 3 | 66.93 | 66.90 | 67.00 | 97.6 | 715.5 | 対象外 |
| EN hipfire MQ4・Shisa由来MTP K3＋N-gram / EN-final | 3 | 40.00 | 40.00 | 40.00 | 193.5 | 353.7 | MTP数・採用率は未取得、tau=.33 |

平均へ入れた生成数は、A-full 384/384/371、A温度.6 334/384/384、A1 348/384/250、C0 384/271/366、C2S 339/384/384、E0/ENは各384/384/384。全てcached_tokens=0。ENはMTPとN-gramを明示有効にし、APIでもMTP実行を確認したが、**日本語会話3回のN-gram候補・採用はともに0**。N-gram採用率を0%とだけ書いてMTP採用率に転用しない。

初期のB1（旧head n1/p.6）は3回平均55.84 / 中央56.04 / 最大56.57 tok/s、採用115/180=63.89%。初期C3（更新head n3、non-strict）は3回平均58.57 tok/s、採用率66.36%。この2runは別engineのCPU buildが低優先度・2jobsで併走していたため、**探索データとして残し、静穏時の主比較へ混ぜない**。B1の後に完了した別processのbare control等と、headだけの厳密な効果量として比較しない。

表中の大小関係から最速・安定性・Eumenesへの採否を決めない。既存設定を維持するのは今回の安全条件によるものであり、性能試験で優位性が確定したためではない。

### 日本語以外の完了測定

| scenario | 現行A 平均 / 中央 / 最大 tok/s | 生成tokens（各試行） | 更新重みC0 |
|---|---|---|---|
| 日本語長文 | 68.50 / 68.69 / 68.90 | 1024 / 1024 / 1024 | CSV参照、3回完了 |
| 英語長文 | 68.12 / 67.95 / 68.60 | 1024 / 1024 / 1024 | CSV参照、3回完了 |
| TypeScript | 68.77 / 68.78 / 68.82 | 768 / 768 / 768 | CSV参照、3回完了 |
| 複数ステップ推論 | 68.70 / 68.67 / 68.77 | 512 / 512 / 512 | CSV参照、3回完了 |

これらを日本語会話の平均へ混ぜない。JSONとToolは短いので速度表から除外した。C2SのTool短文は平均88.43 tok/sに達したが、元の最大約90 tok/sという依頼文の値と同じ測定だとは確認できず、日常会話90 tok/sの証拠とも扱わない。

## 品質・互換性の途中観測（回帰判定は保留）

| 項目 | 現行A / 同設定control A1 | 更新重みC0 / C2S | hipfire E0 / EN |
|---|---|---|---|
| 通常JSON Schema | 各3/3合格 | 各3/3合格 | 各0/3。code fenceを付けた出力 |
| 指示とSchemaの衝突（大阪を依頼、Schemaは京都固定） | A1は3/3合格 | 各3/3合格 | E0は完了2回とも失敗、ENは0/3 |
| Tool名・都市・日付の意味 | 3/3合格 | 3/3合格 | 3/3合格 |
| ISO日付文字列との完全一致 | 3/3 | C0は3/3、C2Sは0/3 | 各0/3 |
| 長文・TypeScriptの完結性 | 上限に達した回答あり | 一部未測定 | 全scenario比較は未完了 |
| 長い会話履歴・32Kでの安定性 | 未完了 | 未完了 | 未完了 |

Tool試験のdate schemaはstringのみで、ISO patternを指定していなかった。C2Sとhipfireの `2026年10月25日` は `2026-10-25` と意味が等しい。したがってCSVの元の `tool_valid`（ISO文字列との完全一致）だけを根拠にTool Callingの意味的退行と断定しない。集計CSVには `tool_exact_iso_match` と `tool_semantic_match` を分けて残す。ISO必須のconsumerへ移行するなら、形式を明示したtool定義で追加検証が必要。

hipfireのSchema失敗は、JSON本文を勝手にcode fenceから取り出して合格へ変換していない。通常single-slot routeでresponse_formatを強制しないという実装上の制約とも一致する。modelが同じ事実を答えていてもAPI契約としては不合格。

日本語の代表出力は依頼に沿って休日の朝昼晩を提案したが、一部に英語語彙の混在や上限での中断があった。blind採点による自然さの優劣は未取得。現行Aの推論回答にはC→B→Aを条件適合と誤判定した例もあり、元から完全正解のcontrolではない。コードは上限でclass実装が閉じない例があるため、実装として正しく動くとは認定していない。明らかな反復崩壊は確認した短い出力範囲では見当たらないが、cap付き検証で無限ループや長期安定性を保証しない。

## 未完了・中断の扱い

- 4K/16K/32K: 4Kの途中で別engine起動を検出して停止した。C0には4092 input / 520 output、66.22 tok/s、prefill937.11 tok/s、TTFT4400.8 msの完了1回がある。後続C0-longestには約32K入力の完了3回とwarmupがあるが、今回の保留理由により公平な比較値にはしない。16Kと全構成のcontext比較は未完了。
- F（ngram-mod）: F-lastの完了記録を保存した。ただし実装は要求間で候補辞書を保持するため、同promptのwarmupと反復で履歴の効果が入る。cached_tokens=0でも日常会話の代表速度へ使わない。別process・異なるwarmupでのcold再試験は競合により未完了。generic draft採用数をMTP採用数へ転用しない。
- R（ROCmFPX v1.7.0）: 別ディレクトリへ取得・展開しCLIを確認した。R2S-quietの日本語会話は完了1回だけで、その後競合中断した。3回平均・採用判断は未取得。
- Dの独立Shisa head: safetensors sidecarを現行custom GGUFへ直接適用できず、共有embedding等を伴うGGUF変換・別fileへのgraftと、その依存stackが必要。本機のsystem Pythonにはtorch / transformers / safetensorsがない。第三者の統合GGUFもあるが本体量子化が変わる。今回は既存のhipfire配布形式に含まれるShisa由来headをEとして実測し、D単独のhead比較は未実施。非対応・不可能と断定しない。
- Ciru/vLLM標準profile: 配布者要件が約100 GB available / 44 GiB KV pool。既存serviceと24 GiB reserveを維持して追加起動する余裕がないため未実施。poolを独自に改変して公開性能と同じ試験と称することはしない。
- 安全中断、port preflight、metrics timeoutはCSVのstatus/errorに残す。これらをengineの生成エラーや品質失敗の件数へ混ぜない。初期の一部port preflightはTIME_WAITも拒否していたため、listen中の衝突を守りつつSO_REUSEADDRを設定する形へ修正した。
- 一部の初期探索runの終了時に、実行中のscript編集に起因するshell再読込エラーが出た。完了responseとCSVは保存されている。以後はPythonへexecする形に直し、後続の完了runでexit0を確認した。モデルや既存serviceの障害ではない。

## 安全条件と測定経路

既存Eumenes / LARM / llama-swapと本番llama-serverの停止・再起動・設定変更は行わない。本番モデルは読み取り専用で参照し、別モデル・binary・evidenceはrepository外に置く。資格情報・利用者の会話履歴は外部へ送らない。推論APIの接続先は127.0.0.1だけ。

開始時には58109で別のprompt-retention検証が動作しており、初回の測定開始を拒否した。次の試行も他処理の再開を検出して中断し、完了した2試行と途中データを保持した。その後の別処理終了は外部の動作であり、今回の操作ではない。完了結果は中断試行と区別して集計する。

別プロセス試験では空きRAM46 GiB、空きGTT30 GiBを起動前の下限とし、実行中もRAM24 GiBを予約する。他llama-serverのmetrics・ポート集合・request countersを0.5秒間隔で監視し、競合・再起動・新規engine・不足を検出したら今回の処理だけを終了する。観測周期未満の競合を完全に排除できるものではない。

本番経由Aは既存backendポート58009へ直接要求する。LARMのallocationやProfile変更でモデルの入替を誘発しない。したがってTTFTにはEumenes UI・音声処理・LARM gatewayの時間を含まない。1M unified KV / 4 slots / slot262144は既存設定のまま。別プロセス比較A1/B/C/Fは65536 context / 1 slot / q4_0 K/V / batch2048 / ubatch512 / Vulkan0へ揃える。画像projectorは別試験にはロードしないので、本番全体の同条件再現ではなくテキスト比較である。

## 共通条件

- 各scenarioでwarmup 1回を除外し、その後に3回。temperature0、seed20261024、top-p .95、top-k64、min-p .05、repeat-penalty1、Thinking無効、同じ合成prompt。EOSを抑制しない。
- `cache_prompt:false`を要求ごとに指定し、responseのcached_tokensも確認する。cacheが実際に効いた行は速度集計から除外する。長さ128 tokens未満の応答は速度代表値から除外し、JSON / Tool / reasoningの機能結果として残す。
- 日常会話384 tokens上限、日本語長文1024、英語長文1024、TypeScript768、JSON256、複数ステップ512、Tool128。長文が512 tokens以上生成されたか実数で確認する。finish_reason=lengthは速度を測れても、回答の完結性を確認できていないことを意味する。
- context試験は**実際の入力を約4096 / 16384 / 32768 tokensへ増やす**。設定上のcontext capacityだけを変える試験ではない。固定の架空資料を反復するため自然会話履歴の代替品質試験にはしない。actual prompt token数をCSVへ保存する。
- decodeはengine responseのtimingsを優先し、欠けた場合のみその要求前後のmetrics差分を使う。初期2試行はmetrics差分のミリ秒丸め値であり、その後のresponse timingsよりわずかに精度が低い。
- TTFTはHTTP送信直前から、最初の非空content/reasoning/tool deltaまでのmonotonic時間。role-only SSE・HTTP header・keepaliveを最初のtokenに数えない。Thinking無効なので通常テキストでは最初の表示文字と一致する。
- 平均は有効な各試行tok/sの算術平均。中央値・最大値と、別途tokens/seconds加重集計も区別できる生データを残す。異なるscenarioや短いJSON応答を日常会話平均へ混ぜない。
- MTP採用率はaccepted draft tokens / drafted tokens。採用済み数は生成総数と区別する。未取得を0%へ変換しない。hipfireのtauは採用率そのものではなく、勝手に相互変換しない。

## 必須指標の読み方

CSVの1行は1試行（warmupを含むがtrial欄で識別）。全行を `fair_comparison_valid=false`、`included_in_speed_summary=false` とし、保留理由を記録する。`eligible_speed` は生成長・cacheなど当初の形式条件だけを示し、公平な比較への適格性を意味しない。中断・APIエラーを成功試行へ変換しない。

`rss_kib`はプロセスRSS、`gtt_bytes` / `vram_bytes`はsystem全体のGPU割当であり、互いに単純加算しない。UMAのモデル実メモリをRSSだけで説明できない。モデルload前後のGTTとMemAvailable、loadログの重み/KV/workspaceを併記する。後半の測定ではDRM fdinfoの `drm-resident-gtt` / `drm-resident-vram` も取得し、同じclient-idを重複集計しない。これは当該processの実際に裏付けのあるGPU bufferであり、RSSやsystem GTTと二重加算しない。

CPU%は `/proc/PID/stat` 差分で100%=1 core。GPU busy sysfsはidle時も常に100を返したので、そのraw値を使用率として使わない。Vulkan後半の `gpu_compute_active_percent` はDRM compute engineの稼働ns / 経過nsから取得した**対象processのcompute engine稼働時間比率**で、shader占有率や最大周波数に対する仕事量ではない。[Linux kernelの定義](https://docs.kernel.org/gpu/drm-usage-stats.html)に従う。HIP/KFDの実行をこのcounterで評価できるとは限らないのでhipfireのGPU使用率は未取得とする。初期試行にも後からこの値を補わない。

電力はamdgpu hwmonのAPU報告値、温度は同センサー。コンセントでのシステム消費電力やGPU単体の校正済み電力ではない。resource samplingは0.5秒周期なので瞬間peakを捕捉できない。

## 90 tok/sという既存値

依頼文にある最大約90 tok/sを、prompt・生成長・cache・Thinking・slot・計測区間と結びつけられる元データは今回確認できていない。現行設定で「通常会話90 tok/s」と認定しない。過去のrepository文書には2026-09-24の更新版MTP/coding256で72.2 tok/s、2026-10-12のSTRIX_LEAN日本語短文で65.14 tok/s等があるが、今回の測定値には算入しない。公開82.45や105.60 tok/sも別ホスト・別workloadの値。

## 再実行

`bash ornith-mtp-reproduce.sh` は説明だけを表示する。以下は次回、再開条件を満たした後に手動実行するための準備であり、今回は実行しない。

```bash
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-A bash ornith-mtp-reproduce.sh --run A
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-A1 bash ornith-mtp-reproduce.sh --run A1
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-B1 bash ornith-mtp-reproduce.sh --run B1
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-C0 bash ornith-mtp-reproduce.sh --run C0
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-C3 bash ornith-mtp-reproduce.sh --run C3
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-F bash ornith-mtp-reproduce.sh --run F
```

出力先は未作成の絶対パスを指定する。既存出力を上書きしない。競合があれば中断が正常な安全動作。`ORNITH_SCENARIOS=ja-chat,json,tool` のように対象を絞れるが、結果は実施したsubsetとして報告する。新規engine起動に使うポートは既定18091、`ORNITH_PORT`で空きポートへ変更可能。cleanupの対象はこのscriptがPopenした子プロセスだけ。

全生データと中断記録は `/srv/ai/evidence/ornith-mtp-20261024/`。モデル重み・生成ログをrepositoryへ取り込まず、機械処理用の試行結果だけを `ornith-mtp-results.csv` に保存する。

### hipfireの導入を再現する場合

既存の検証環境では再導入不要。以下は今回使用したsource buildとローカルkernel生成の経路。空の専用ディレクトリで実施し、既存checkoutを更新・resetしない。

```bash
ornith_trial_root=/srv/ai/apps/ornith-mtp-trial-20261024
git clone --depth 1 --branch v0.4.2.1 https://github.com/warpfront/hipfire.git "$ornith_trial_root/hipfire"
CARGO_BUILD_JOBS=2 nice -n 15 cargo build --release --locked -p hipfire-cli --manifest-path "$ornith_trial_root/hipfire/Cargo.toml"
CARGO_BUILD_JOBS=2 nice -n 15 cargo build --release --locked -p hipfire-daemon --manifest-path "$ornith_trial_root/hipfire/Cargo.toml"
HIPFIRE_HOME="$ornith_trial_root/home" HIPFIRE_KERNEL_CACHE="$ornith_trial_root/kernel-cache" HIPFIRE_ROCM_PATH=/opt/rocm HIPFIRE_JIT_JOBS=2 timeout 240s "$ornith_trial_root/hipfire/target/release/daemon" --precompile
```

モデル取得元はHF repository `hipfire-models/ornith-1.5-35b-a3b` のrevision `6cac51031c4bc6fb0135ef8af97be749666b453d`。`resolve/<revision>/ornith-1.5-35b-a3b.mq4` と同stemの `.mtp` を専用modelsディレクトリへ取得し、以下と一致した場合だけpartialファイルから正式名へrenameした。公開重みの取得のみで、推論内容をHFへ送らない。

| ファイル | bytes | SHA-256（取得後に検証済み） |
|---|---:|---|
| ornith-1.5-35b-a3b.mq4 | 19020296510 | f329b497eb8684d889c184a0dcf1388ab6171f99a1c72052d7e2a3bee4f5934b |
| ornith-1.5-35b-a3b.mtp | 484778112 | 38c22accd08c46f2dd6b2bec1e88550ce0f223c69ea038ff13ddb80f6ccb3a37 |

```bash
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-E0 bash ornith-mtp-reproduce.sh --run E0
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-E3 bash ornith-mtp-reproduce.sh --run E3
ORNITH_OUTPUT=/srv/ai/evidence/ornith-mtp-rerun-EN bash ornith-mtp-reproduce.sh --run EN
```

E0はAR、E3はMTP K3、ENはMTP K3＋N-gramを明示有効にする。session cacheは0、Thinking無効、K/Vはq8、context65536。Vulkan側q4_0 KVと量子化形式は同一ではない。hipfireのtokenizer/engineによるusageとtimingsをそのまま記録し、precisionが小数1桁である点も保持する。MTP候補数・採用数がHTTPへ露出しない場合は未取得とし、tauから採用率を逆算しない。`ORNITH_TEMPERATURE=0.6 ORNITH_SCENARIOS=ja-chat` で本番既定温度の追加試験も再現できる。
