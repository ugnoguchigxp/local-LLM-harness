# ASRモデル選定記録 — 2026-08-31

## 現在の判断

Whisper large-v3-turbo Q5_0をwhisper.cpp HIPで`stt-default`として試用する。
本採用ではなく、実利用時の速度・誤認識を観察するためのtrialである。

Qwen3-ASR 1.7Bはmodel、runtime、systemd serviceを変更・削除せずResidentのまま保持し、
明示route `stt-qwen`と`stt-default`のfallback候補にする。問題があればdefault routeを
Qwenへ戻すだけでrollbackできる。

## 同一条件で評価したモデル

| モデル | 実行系 | License | 17 clip CER | ASR mixed p95 | LLM mixed | 判断 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Qwen3-ASR 1.7B | PyTorch ROCm FP16 | Apache-2.0 | 3.498% | 3.015秒 | 21.904 tok/s | rollback用Resident |
| Qwen3-ASR 0.6B | PyTorch ROCm | Apache-2.0 | 8.93% | — | — | 品質不足 |
| ReazonSpeech k2-v2 | sherpa-onnx CPU | Apache-2.0 | 10.253% | 0.141秒 | 26.738 tok/s | 品質不足 |
| Kotoba Whisper v2.0 Q5_0 | whisper.cpp CPU | Apache-2.0 / MIT | 7.358% | 5.849秒 | — | 品質・性能不足 |
| Whisper large-v3-turbo Q5_0 | whisper.cpp CPU | MIT | 2.654% | 6.218秒 | 16.429 tok/s | CPU性能不足 |
| Whisper large-v3-turbo Q5_0 | whisper.cpp HIP | MIT | 3.257% | 1.186秒 | 26.639 tok/s | 試用 |
| ReazonSpeech ESPnet v2 beam 20 | PyTorch ROCm FP32 | Apache-2.0 | 5.428% | 3.627秒 | 23.957 tok/s | 品質・mixed性能不足 |
| ReazonSpeech ESPnet v2 beam 1 | PyTorch ROCm FP32 | Apache-2.0 | 8.685% | 1.966秒 | 26.871 tok/s | 速度確認のみ |

性能値は4.032秒fixture、1 warmup除外、10 iterationの結果。CERは同じ17日本語clip、
合計221.46秒を同じ正規化で比較した値である。

## 試用切替後の確認

2026-08-31にLARMの実ルートを切り替え、`stt-default`が`whisper-asr` / `whisper-asr-trial`、
`stt-qwen`が`qwen-asr` / `qwen-asr-current`へ解決されることを確認した。同じ音声の文字起こし、
LLM・ASR・TTS統合スモーク、各単体と3系統同時実行を各10回行い、全40 measured caseが成功した。

| 指標 | 単体 | 同時実行 |
| --- | ---: | ---: |
| Whisper ASR total p95 | 0.470秒 | 1.184秒 |
| Whisper ASR RTF p95 | 0.117 | 0.294 |
| LLM output p50 | 26.695 tok/s | 25.874 tok/s |
| TTS total p95 | 0.350秒 | 0.625秒 |

error、429、queue、測定中のidentity変化、終了後のAllocation leakはいずれも0。切替前後でQwen ASR、
LLM、VOICEVOXのPIDは変わらず、Qwen ASRはHOTのまま保持した。raw reportはrepository外の
`/srv/ai/logs/larm-performance/20260831T141850Z-whisper-turbo-q5-hip-deployed-trial.json`にある。

Qwen側のhost状態backupはrepository外の
`/srv/ai/logs/larm-trials/20260831T140152Z-whisper-asr/`に保存した。model weight自体は複製せず、
checksum固定の既存model、稼働中service、明示routeをrollback用に保持している。

試用中のWhisperはroot権限を使わないuser systemd serviceである。user lingerは無効なので、host再起動後の
自動復帰は未検証・未保証。本採用時はrepositoryのsystem service unitをprivileged rolloutし、rebootを含む
acceptanceを行う。

## Whisper trialで監視する点

評価中に「帰国後→企画後」「官庁→環状」「峡谷→強国」「要求→有給」を確認している。
数値CERはQwenを上回るが、これらは意味に影響するため、本採用判定では実利用時のsemantic errorを
優先する。次のいずれかが起きた場合はQwenへ戻す。

- 意図、固有名詞、否定、数量、要求内容を変える誤認識が反復する。
- LLM・TTS同時利用時のASR p95が1.5秒を継続的に超える。
- provider error、429、process restart、GPU memory不足が発生する。
- 利用者がQwenより認識品質が低いと判断する。

## 後日の再検証条件

日本語短発話でQwen3-ASR 1.7Bを上回ると評判になったOSSモデルが現れた場合、model weightと
主要runtimeがMITまたはApache-2.0であることを確認して再検証する。parameter数や公開benchmarkだけで
置き換えず、今回と同じ17 clip CER、critical semantic error、ASR単体、LLM・ASR・TTS mixed、
100 request安定性を比較する。

候補の詳細、revision、checksum、raw report名は
[`../specs/asr-alternative-evaluation.html`](../specs/asr-alternative-evaluation.html)に記録する。
