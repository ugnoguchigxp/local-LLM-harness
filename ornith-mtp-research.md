# Ornith 1.5 35B / Strix Halo MTP調査

調査日: 2026-10-24（JST）。公開性能は本機の実測ではない。今回の試行結果は `ornith-mtp-benchmark.md` と `ornith-mtp-results.csv` に分離する。

**実機検証は保留。** 同日に利用者から、背後でStrixの再起動検証が動いているため今回は準備を残して後日にする指示があった。以後の推論・測定は実行しない。既存の途中結果は公平な性能比較に使わず、100 tok/s達成可否と採用判断は次回へ持ち越す。公開情報の調査、取得済みモデル・エンジン、再実行用スクリプトを保存する。現行構成の記述は調査時点の観測であり、再開時に再確認が必要。

## 現行環境

| 項目 | 読み取り確認結果 |
|---|---|
| ホスト | gnosis、AMD Ryzen AI MAX+ 395、16 core / 32 thread、Radeon 8060S / gfx1151、物理128 GB、Linux表示121 GiB |
| OS / kernel | Ubuntu 26.04.1 LTS、7.0.0-34-generic、in-tree amdgpu |
| GPUユーザーランド | Mesa RADV 26.0.8-1ubuntu0.3、libdrm-amdgpu1 2.4.131-1 |
| ROCm / HIP | `/opt/rocm/core-10.0/.info/version` は **10.0.0**。`hipconfig --version` はHIP compiler `7.15.26333-0000000`、hipRuntimeGetVersionは71526333。ROCmとHIPの番号を混同しない。`/opt/rocm/.info/version` は存在しない |
| 稼働LLM | llama.cpp派生 build 244 / `0fc9568`、`larm-chat-input-engine-20261022-prefix-v1/llama-server`。現行はVulkanでありHIP実行ではない |
| モデル | `Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf`、19,052,439,552 bytes |
| 現行モデルSHA-256（実ファイル再検証） | `aa35045aab39163851c8584e6cf8cc6f33e8fc2ffe28ca627d3414ec66584704` |
| GGUF | `qwen35moe`、file_type 106、ROCmFP4 STRIX_LEAN、40 target layers + 1 NextN layer、256 experts / top-8、埋込幅2048、vocab 248320、native context 262144 |
| MTP | `nextn_predict_layers=1`、`blk.40.*` 20 tensorsあり。ただし起動引数と `/props` の両方で `spec-type none`。**現在MTPは使用していない** |
| オフロード | `-dev Vulkan0 -ngl 999 --fit off --no-mmap --flash-attn on` |
| KV / context | K/Vともq4_0、unified pool 1048576 tokens / 4 slots、`/props` の1slot contextは262144 |
| バッチ | batch 2048 / ubatch 512 / threads 16 / poll 100 / continuous batching |
| キャッシュ | checkpoints 8 / checkpoint interval 1024 / cache RAM 0 / cache-prompt有効 / cache-reuse 0 / cache-idle-slots無効 |
| サンプリング既定 | reasoning off、temperature .6、top-p .95、top-k 64。測定は要求単位でgreedyへ揃える |
| 画像 | BF16 mmprojあり、image-max-tokens 4096。今回の速度測定はテキストのみ |
| 起動経路 | llama-swap.service → `/var/lib/larm/provider-config/llama-swap.yaml` → 子llama-server。swap入口127.0.0.1:8083、観測した本番子ポート58009 |
| GPU関係環境変数 | 本番のallowlist確認: `HIP_VISIBLE_DEVICES=-1`, `ROCR_VISIBLE_DEVICES=-1` |
| 空き資源（開始時） | MemAvailable 約56 GiB、GTT使用約58.8 GiB / 上限100 GiB、ディスク約791 GiB空き。UMAのためRSSだけをモデル実メモリとみなさない |

設定上の要求解決は `ornith1.5Strix`（または同game）→ Provider `llm` → `llm-ornith15-strix` → runtime `ornith15-strix-conversation` → llama-swap model ID同名 →上記プロセス。本番消費者の会話履歴・資格情報は読み出していない。全Eumenes要求がこのProfileを選ぶとまでは断定しない。ContextStillも同runtimeへ明示的に解決できる。ポート自体をProviderの恒久IDとしない。

別のprompt-retention検証用Ornithが58109に存在し、実際に長文prefillと再起動を繰り返していた。これは本番設定のdriftとは判定しない。競合検出時には今回の要求または今回だけの子プロセスを中断する。

## A. 公式MTPの更新とllama.cpp

- [公式BF16履歴](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B/commits/main): 最新revision `10fbf86fed7ecee4a061f8b499a618f46001cac1`、2026-08-23に最後のsafetensors shardを更新。
- [公式GGUF履歴](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF/commits/main): 2026-08-24にBF16/Q4_K_M/Q5_K_M/Q6_K/Q8_0とmmprojを再配布。最新revision `12393612fd4f730ff5aadc23e9b8f9648aa49ceb`。2026-10-24時点でこれ以降の更新はAPIにない。
- [初期MTP問題の一次議論](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B/discussions/10)は初期重みについての報告。古いREADMEの「公式MTPは未学習」という記述を現在のrevision全体へ一般化できない。
- 本機の旧ファイルと保存済み更新ファイルを実際にGGUF readerで検査した。新旧ともheadは存在するが、head norm値は異なる。ファイル名・更新日時だけで同一性を判定していない。
- 公式最新safetensorsのheaderと3本の小さなBF16 norm tensorのみHTTP Rangeで直接確認。native RMS normはGGUF変換時に+1されるため、その補正を考慮すると保存済み更新版の値と一致した。公式のMTP更新を独立に裏付ける。一部normの一致は全重みの一致証明ではない。

| norm | 現行旧GGUFの平均 | 更新GGUFの平均 | 公式最新BF16の平均（GGUF化前） |
|---|---:|---:|---:|
| shared_head_norm / mtp.norm | 1.022813 | 2.925126 | 1.925126 |
| attn_norm / input_layernorm | 1.000064 | 0.904975 | -0.095025 |
| attn_q_norm / self_attn.q_norm | 1.003901 | 1.767248 | 0.767248 |

保存済み更新版は `/srv/ai/models/halofpx/ornith-1.5-35b/Ornith-1.5-35B-A3B-ROCmFP4.gguf`、19,052,438,944 bytes。[HaloFPX registry](https://github.com/julianmb/halofpx/blob/main/registry/models.json)は公式Aug-24 Q8_0からのrequantと記載し、SHA-256 `0f907917a1bfe4e0ca0d281e5709dcf34b6277063e94fab29491bb5c80fda696`を指定する。旧本番ファイルは保持する。

[llama.cppの実装](https://github.com/ggml-org/llama.cpp/blob/master/common/speculative.cpp)にはdraft-mtp、外部draft、N-gramがある。組込NextNは別のフルLLMを必須としない。draftの候補作成とtargetによる検証・rollbackにコストがあり、採用率が低いほど遅くなる。候補数を増やすだけでは改善しない。量子化形式とheadの質とengine実装を別々に評価する必要がある。

本機CLIヘルプで `--spec-type draft-mtp`、`--spec-draft-n-max`、`--spec-draft-p-min`、`--spec-draft-device` の実在を確認。旧 `--draft` はremovedと表示されるので使わない。本機のcustom GGUF type 100/101/106はstock GGUF readerでは読めず、ROCmFPX forkのreaderでは読めた。ファイル形式のROCmFP4という名称はHIP backend使用の証明ではない。

AMDでのMTPはROCm/HIP・Vulkanの両方に実装があるが、組み合わせは要検証。[異なるbackendへdraftが配置される問題](https://github.com/ggml-org/llama.cpp/issues/24492)を避けるため、今回の別プロセス試験ではtarget/draftをVulkan0へ固定し、HIP可視性を無効化する。自動fitは無効。本機forkには `--spec-mtp-strict-qwen` もある（既定無効）。有効にすると境界とrollbackの厳密検証を行うため、品質確認済みでない非strict結果を本番採用根拠にしない。[最近のVulkan MTP退行報告](https://github.com/ggml-org/llama.cpp/issues/30688)もあり、最新ビルドへの更新そのものを高速化とみなさない。

## B. Shisa.AIの改善ヘッド

[Shisa MTP-ONLY](https://huggingface.co/shisa-ai/Ornith-1.5-35B-A3B-MTP-ONLY)は844,640,768 parameters / 19 fused tensors / BF16 1.689 GBのsafetensors sidecar。Qwen3.6互換headをOrnith hidden statesへKL蒸留し、target本体と共有LM headは凍結する。単独LLMとして起動できず、既存GGUFへの単純なファイルコピーやリネームでは適用できない。確認revisionは `2b19b31bfe1659c6b0d9459ec3cbd87e34a322ef`、最終更新は2026-08-21。公式の8月23日更新より前なので、このcardのnative比較を「最新の公式headに対する改善」とは解釈しない。

配布者のmatched MTP3 gateはgreedy、concurrency 1、10 prompts × 3回。全体acceptanceはnative 32.19%→12K蒸留60.51%、code subsetは69.27%。これはこのStrix Halo上の性能ではない。学習窓2048、code-heavyデータであり、日本語会話・32K履歴で同じ改善があるとは限らない。訓練データ本体は非公開なので、headを使う再測定は可能でも訓練の完全再現は不可。

BF16/FP8のmerged配布があり、公開の起動例はvLLM 0.27.1。既存GGUF本体を保持するなら変換済みheadを外部draftとして読み込むか、新しい別GGUFへgraftする経路になる。本機forkのserver sourceにも外部draft + MTP contextを作る分岐があるが、Shisa safetensorsを直接渡すことはできない。[第三者によるShisa12K統合GGUF](https://huggingface.co/BillFan666/Ornith-1.5-35B-A3B-ADQ4-Shisa12K-MTP-GGUF)も公開されている。これは本体の量子化も異なるため、速度差をheadだけの効果と解釈しない。

Shisa headはApache-2.0、Ornith targetはMITと表記される。混在配布では両方のattributionを保持する。Dの直接試験と、Shisa由来headを内包するhipfire Eの試験は同じ構成ではない。

## C. hipfire

[model card](https://huggingface.co/hipfire-models/ornith-1.5-35b-a3b)、[engine](https://github.com/warpfront/hipfire)、[導入手順](https://github.com/warpfront/hipfire/blob/v0.4.2.1/docs/GETTING_STARTED.md)を確認。取得したreleaseはv0.4.2.1、commit `6b363a56a1ae28ed421178d3c7eba9f6f4bacbb5`。masterとは区別する。

Strix Halo gfx1151を明示対応。Rust + HIPの独立engineで、GGUFをそのまま使う実装ではない。gfx1151にはROCm 7.2以上というREADME要件がある。ただし**v0.4.2.1の配布kernel packはROCm [10.1, 11.0) を要求**し、本機10.0.0では実際にインストールを拒否した。READMEの最低版だけではpack互換を判断できない。ローカルcompilerでのsource経路を確認し、グローバルなROCm・ドライバ更新やprofile改変は行わない。

| 配布物 | サイズ・用途 |
|---|---|
| `.mq4` | 19,020,296,510 bytes、graded MQ4G256V2、attentionの一部MQ6・router等Q8 |
| `.mq4r` | 18,700,570,368 bytes、uniform MQ4G256V2、qt44中心、従来の一部高精度tierを変更 |
| `.mtp` | 484,778,112 bytes、Shisa由来head、圧縮draft vocab 16384。targetのfull vocab検証は残る |
| `.vl` | 907,482,592 bytes、vision sidecar。今回のテキスト速度試験には不要 |

model repo revision `6cac51031c4bc6fb0135ef8af97be749666b453d`。モデルcardの更新時点ではMQ4R runtime修正PR #664が未mergeと記載されるため、古いengineでの動作を推定しない。まずgfx1151で公表測定のあるMQ4を選ぶ。

公開のgfx1151/code-editing結果はAR約70 tok/s、MTP K3 77.4、MTP+N-gram約150。**全て本機未測定の公開値**。モデルcard自身がproseでは採用率が低下すると明記する。K4/K5/K6でさらに遅くなる例もある。上記を日本語会話100 tok/s達成の根拠にはしない。

CLI/sourceでは次が実在する: `pull`, `run`, `serve`, `bench`, `--spec off|mtp|ngram|auto`, `--draft-max`, `--max-seq`, `--kv-mode q8`。serveのbindは**位置引数** `[model] [host] [port]`。未確認の `--host` / `--port` を類推して使わない。MTP+N-gramの現行gateと対象familyはreleaseごとのsourceで確認する。一般ngram selectorとMTP中のngram takeoverは別の設定。

[HTTP契約](https://github.com/warpfront/hipfire/blob/v0.4.2.1/docs/SERVE.md)は `/v1/chat/completions`、SSE、usage、toolsに対応。ただし**通常のsingle-slot routeはresponse_format/json_schemaを強制しない**。HTTP 200やJSONらしい出力だけをJSON Schema互換と判定しない。multi-slot routeのgrammar対応は別途設定・試験が必要。temperature>0のrouteやgreedyとの違い、session cache、thinking既定にも注意する。

導入はsource checkoutから `cargo build --release --locked -p hipfire-cli` / `-p hipfire-daemon` が公式経路。実験用checkout、models、`HIPFIRE_HOME`を `/srv/ai/apps/ornith-mtp-trial-20261024/` 内へ分離した。両方のbuildが成功し、`hipfire version --json`でsource/buildのcommit一致・dirty=falseを確認。提供install scriptを無検証でpipe実行せず、sourceとCLIヘルプを確認した。gfx1151 release kernel packは版不一致で拒否されたが、**本機の既存hipccで `daemon --precompile` を実行し、218 indexed modulesのpackagingに成功した**。その後に別ポートで実際の生成試験を行った。engineはApache-2.0（一部ファイルMIT）、モデルはMIT target + Apache-2.0 headであり、量子化はlossy。

## D. その他の比較対象

- ROCmFPX / HaloFPX: 現行自身がcustom FP4最適化を利用済み。[HaloFPX](https://github.com/julianmb/halofpx)のOrnith公開105.60 tok/sは独立検証対象。本機の2026-09-24記録は更新版MTP n4で72.2、OFF67.9だったが、coding256 tokens / q8 KV / context131072という別条件なので今回の日本語会話と混ぜない。
- [更新版ROCmFP4の現行model card](https://huggingface.co/julianmb/Ornith-1.5-35B-A3B-ROCmFP4-GGUF)は、以前の「MTPを無効化」という推奨を撤回し、現在は **n-max2 / p-min .6、公開100.96 tok/s / acceptance87.0%** を推奨する。n3は周期3の応答変動、n4はランダムな変動を報告し、n2でも完全な決定性はない。測定は別ホスト・Mesa25.3.6・ROCmFPX c49ebdb・Vulkan・slot1・greedy-ishであり、日本語会話の保証ではない。本機ではC2Sとしてstrict-qwen付きn2も優先試験する。古いcardやHaloFPX registryの数値だけを最新の結論として引用しない。
- llama.cpp `ngram-mod`: 追加モデルなしで試せる。反復するcode編集・引用に有利な条件があるが、自由な会話での採用率とTTFTは別測定する。架空の文章を大量反復するcontext試験ではngramに有利になり得るため、日常会話の平均へ混ぜない。
- stock Vulkan / HIP: stockのQ4_K_M等はcustom type106と異なる。engineだけ差し替えて同一モデル比較できるとは限らない。Vulkan優位を全機種・全workloadへ一般化しない。
- vLLM / SGLang / NInfer: 公開のNVIDIA Blackwell等での高性能はgfx1151の実績に読み替えない。新規大容量BF16/FP8スタックは現行GPU常駐と並立させる資源・対応kernelの確認が必要。本検証のために新engineや独自head変換器を実装しない。
- [Ciru Halo Agentの配布者手順](https://huggingface.co/jcbtc/Ornith1.5-Ciru-Halo-Agent-vllm-strix-halo/blob/main/INSTALL.md)は、Strix Halo実績と専用vLLM/AITER・DFlash2一式を公開する一方、標準profileに**約100 GBのavailable RAM**、44 GiB KV/state poolを要求する。今回の開始時約56 GiB、競合検証が終了した一時点でも約86 GiBのavailableと24 GiBの予約を考慮すると、この標準profileの追加起動は安全範囲に入らない。Ubuntu手順も配布者の独立検証対象外と明記される。既存service停止やglobal SDK変更で余裕を作らず、未測定とする。
- MLXは今回のLinux AMD実機向けではない。別モデルへの変更もOrnith高速化の成功に数えない。

## 証跡と公開情報の扱い

読み取り情報・公式API応答・取得したREADME/source・試行request/response・resource samples・build/download logsは `/srv/ai/evidence/ornith-mtp-20261024/`。モデル・binary・ログはsource repository外に置く。会話入力はこの試験用の合成promptだけで、推論要求は127.0.0.1限定。公開値、過去のローカル測定、今回の実測、未取得を分ける。未取得のacceptanceを推測しない。
