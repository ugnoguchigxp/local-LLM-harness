# VOICEVOX CORE TTS adapter

27B LLMとGPUを競合させず、短い会話応答を低遅延で返すOpenAI互換TTSアダプター。

- VOICEVOX CORE: 0.17.0
- 音声モデル: 0.vvm（model release 0.16.4）
- backend: CPU 16 threads
- service: `voicevox-tts.service`
- port: `8084`
- default voice: `Kasukabe_Tsumugi`（style ID 8）

VOICEVOX CORE自体は逐次ストリーミングを提供しない。harness側でLLM出力を文単位へ分割して呼び出す。

VOICEVOX公式ダウンローダーは利用規約への同意を要求する。生成音声を利用する際は選択した音声ライブラリの正式なクレジットを表示すること。既定話者は`VOICEVOX:春日部つむぎ`。

APIは正式表記を`GET /v1/audio/voices`から返し、音声レスポンスにはASCIIの`X-VOICEVOX-Credit`ヘッダーを付ける。
