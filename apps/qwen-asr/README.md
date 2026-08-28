# Qwen3 ASR adapter

gnosisでQwen3-ASRをOpenAI互換の`POST /v1/audio/transcriptions`として公開する薄いFastAPIアダプター。

- 常駐モデル: `Qwen/Qwen3-ASR-1.7B`
- dtype: FP16
- backend: PyTorch ROCm / gfx1151
- service: `qwen-asr.service`
- port: `8081`

依存関係はPython 3.13環境へ導入する。PyTorchはgfx1151対応ROCm wheelを先に入れ、その後で次を入れる。

```bash
python3.13 -m venv /srv/ai/apps/qwen-speech/asr/.venv
/srv/ai/apps/qwen-speech/asr/.venv/bin/pip install -r apps/qwen-asr/requirements.txt
```

配備時は`api.py`を`/srv/ai/apps/qwen-speech/asr/api.py`へ配置する。モデルとdtypeはsystemdの環境変数で切り替えられる。
