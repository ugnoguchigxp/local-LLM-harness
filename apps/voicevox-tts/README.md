# VOICEVOX CORE TTS adapter

27B LLMとGPUを競合させず、短い会話応答を低遅延で返すOpenAI互換TTSアダプター。

- VOICEVOX CORE: 0.17.0
- 必須音声モデル: 0.vvm（model release 0.16.4）
- 任意音声モデル: 4.vvm（男性系話者。operator同意・staging後に自動ロード）
- backend: CPU 16 threads
- service: `voicevox-tts.service`
- port: `8084`
- default voice: `Kasukabe_Tsumugi`（style ID 8）
- request body上限: 64 KiB
- 同時合成: 1。使用中は`429`、`/health?fail_on_no_slot=true`は`503`を返す

systemdはrelease内の本adapterをworking directoryとして実行し、起動前に
`verify-external-assets.ts --require-valid`で全VVMを検証します。外部VOICEVOX checkout内へ
adapter sourceをcopyしないため、LARM release切替後のservice restartでsourceも同じ世代へ揃います。

COREと<code>0.vvm</code>のrelease metadataの正本は
[`../../deploy/local-node/sources.lock.yaml`](../../deploy/local-node/sources.lock.yaml)です。VOICEVOXはmodel
snapshotではなく、利用規約への同意を伴う外部runtime release bundleとしてoperatorが配備します。
このためLARMのmodel artifact manifestには登録しません。source lockはVVM release 0.16.4の配布URL、
revision、bytes、SHA-256、termsとoperator同意要件を固定し、
`verify-external-assets.ts --require-valid`とpreflightが実fileとの一致を検証します。

VOICEVOX CORE自体は逐次ストリーミングを提供しません。現在のLARMも文分割を行わないため、逐次発話が必要な利用側はLLM出力を文単位へ分割して呼び出します。

VOICEVOX公式ダウンローダーは利用規約への同意を要求する。生成音声を利用する際は選択した音声ライブラリの正式なクレジットを表示すること。既定話者は`VOICEVOX:春日部つむぎ`。

APIは正式表記を`GET /v1/audio/voices`から返し、音声レスポンスにはRFC
8187形式でUTF-8 percent encodeしたASCIIの`X-VOICEVOX-Credit`ヘッダーを付ける。

`POST /v1/audio/speech`は最大4096文字を受け付け、`wav`またはmono s16leの`pcm`を返します。`stream: true`、日本語以外、`instruct`は明示的に拒否します。

VOICEVOX固有の制御は次の範囲です。

- `style`: voice catalogのstyle名または数値style ID
- `speed`: 0.5〜2.0、既定1.0
- `pitch_scale`: -0.15〜0.15、既定0.0
- `intonation_scale`: 0.0〜2.0、既定1.0

`GET /v1/audio/voices?model=voicevox-core`は、安定voice ID、表示名、話者UUID、
`voice_presentation`、default style、全talk style、各制御範囲、creditを返します。
0.vvmでは四国めたんとずんだもんの複数styleも広告します。従来のvoice名と数値style IDは
互換入力として残します。
Typed clientでは`getVoicevoxCatalog()`がこの拡張catalogを検証して返します。
他TTS Providerの一覧は共通の`listVoices(model)`を使用します。

`VOICEVOX_VVM_FILES`は起動に必須のcomma区切りVVM filename、
`VOICEVOX_OPTIONAL_VVM_FILES`はstaging済みの場合だけロードするVVM filenameです。
path traversalを避けるためbasename以外は受け付けません。任意assetが存在する場合も、
`verify-external-assets.ts`はsource lockと異なるidentityを拒否します。
