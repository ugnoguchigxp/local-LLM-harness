# Qwen3 TTS optimized adapter

表現力を優先する発声経路。local-nodeではgfx1151向けforkを固定し、ROCm向け修正をパッチとして管理する。

- upstream: `https://github.com/dingausmwald/Qwen3-TTS-Openai-Fastapi`
- pinned commit: `eb14f6e6a50445cf442979abb9203ff0d5042c43`
- production model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- comparison model: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`（production Registry対象外）
- service: `qwen-tts.service`
- port: `8082`
- LARM policy: Preferred。installerはboot時disabledにし、明示的な`tts-expressive` Allocationだけが起動する

upstreamとrevisionの正本は[`../../deploy/local-node/sources.lock.yaml`](../../deploy/local-node/sources.lock.yaml)、
production modelのfile list、bytes、SHA-256、snapshot digest、active targetの正本は
[`../../deploy/local-node/models.yaml`](../../deploy/local-node/models.yaml)です。Qwen TTSは最初のPreferred
directory snapshot activation対象です。

配備手順:

```bash
git clone https://github.com/dingausmwald/Qwen3-TTS-Openai-Fastapi.git /srv/ai/apps/Qwen3-TTS-Openai-Fastapi
git -C /srv/ai/apps/Qwen3-TTS-Openai-Fastapi checkout eb14f6e6a50445cf442979abb9203ff0d5042c43
git -C /srv/ai/apps/Qwen3-TTS-Openai-Fastapi apply /srv/ai/apps/local-LLM-harness/apps/qwen-tts/rocm-gfx1151.patch
install -m 0644 /srv/ai/apps/local-LLM-harness/apps/qwen-tts/config.production.yaml \
  /srv/ai/apps/Qwen3-TTS-Openai-Fastapi/config.production.yaml
```

パッチは次を行う。

- `TTS_CONFIG`による設定パス指定
- gfx1151で失敗する`torch.multinomial`のCPU fallback
- forkの現行APIに存在しない`compile_talker`引数の除去
- temperature等の生成設定を通常生成・stream生成へ渡す
