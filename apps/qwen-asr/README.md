# Qwen3 ASR adapter

gnosisでQwen3-ASRをOpenAI互換の`POST /v1/audio/transcriptions`として公開する薄いFastAPIアダプター。

- 常駐モデル: `Qwen/Qwen3-ASR-1.7B`
- dtype: FP16
- backend: PyTorch ROCm / gfx1151
- service: `qwen-asr.service`
- port: `8081`
- upload上限: 256 MiB、音声長上限: 3600秒（systemd環境変数で縮小可能）
- 同時推論: 1。使用中は`429`、`/health?fail_on_no_slot=true`は`503`を返す

`prompt`と0以外の`temperature`は未対応として明示的に拒否する。multipart本文はparserへ渡す前にも
ASGI middlewareで上限を適用し、chunked uploadを含めて一時diskの無制限消費を防ぐ。

依存関係はPython 3.13環境へ導入する。PyTorchはgfx1151対応ROCm wheelを先に入れ、その後で次を入れる。

```bash
python3.13 -m venv /srv/ai/apps/qwen-speech/asr/.venv
/srv/ai/apps/qwen-speech/asr/.venv/bin/pip install -r apps/qwen-asr/requirements.txt
```

配備時は`api.py`を`/srv/ai/apps/qwen-speech/asr/api.py`へ配置する。モデルとdtypeはsystemdの環境変数で切り替えられる。
