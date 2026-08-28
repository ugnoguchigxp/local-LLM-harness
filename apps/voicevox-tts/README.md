# VOICEVOX CORE TTS adapter

27B LLMとGPUを競合させず、短い会話応答を低遅延で返すOpenAI互換TTSアダプター。

- VOICEVOX CORE: 0.17.0
- 音声モデル: 0.vvm（model release 0.16.4）
- backend: CPU 16 threads
- service: `voicevox-tts.service`
- port: `8084`
- default voice: `Kasukabe_Tsumugi`（style ID 8）
- request body上限: 64 KiB
- 同時合成: 1。使用中は`429`、`/health?fail_on_no_slot=true`は`503`を返す

CORE releaseの正本は
[`../../deploy/gnosis/sources.lock.yaml`](../../deploy/gnosis/sources.lock.yaml)です。VOICEVOXはmodel
snapshotではなく、利用規約への同意を伴う外部runtime release bundleとしてoperatorが配備します。
このためLARMのmodel artifact manifestには登録しません。`0.vvm`のreleaseは現時点でこのREADMEにだけ記録され、
file manifestとchecksumは未整備です。

VOICEVOX CORE自体は逐次ストリーミングを提供しません。現在のLARMも文分割を行わないため、逐次発話が必要な利用側はLLM出力を文単位へ分割して呼び出します。

VOICEVOX公式ダウンローダーは利用規約への同意を要求する。生成音声を利用する際は選択した音声ライブラリの正式なクレジットを表示すること。既定話者は`VOICEVOX:春日部つむぎ`。

APIは正式表記を`GET /v1/audio/voices`から返し、音声レスポンスにはRFC
8187形式でUTF-8 percent encodeしたASCIIの`X-VOICEVOX-Credit`ヘッダーを付ける。

`POST /v1/audio/speech`は最大4096文字を受け付け、`wav`またはmono s16leの`pcm`を返します。`stream: true`、日本語以外、`instruct`は明示的に拒否します。
