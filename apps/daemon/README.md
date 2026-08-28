# @larm/daemon

Linux Runtimeを観測・制御するLARM daemonです。既定で `config/gnosis` を読み、SystemdBackendとLlamaSwapBackendへRuntime単位でルーティングします。

## Start

```bash
cd /srv/ai/apps/local-LLM-harness
bun run dev
```

既定は `http://127.0.0.1:9810` です。

```bash
export LARM_CONFIG_DIR=/srv/ai/apps/local-LLM-harness/config/gnosis
export LARM_PORT=9810
export LARM_PREFERRED_IDLE_TTL_SECONDS=60
bun run dev
```

## Control API

```bash
curl http://127.0.0.1:9810/health
curl http://127.0.0.1:9810/runtimes
curl http://127.0.0.1:9810/state
curl -sS -X POST http://127.0.0.1:9810/prepare \
  -H 'Content-Type: application/json' -d '{"profile":"voice"}'
curl -sS -X POST http://127.0.0.1:9810/resolve \
  -H 'Content-Type: application/json' -d '{"capability":"llm.general"}'
```

- Resident Runtimeは停止しません。
- Preferred Runtimeだけを`prepare`とidle `release`の対象にします。
- systemdのstart/stop権限がない場合、SystemdBackendは観測専用として動作します。
- llama-swap process自体の寿命はsystemdが管理し、daemonはmodelのload/unloadだけを委譲します。
