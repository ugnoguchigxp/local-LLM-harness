# @larm/daemon

Local AI Provider の daemon。S0 で観測、S1 で leases と Preferred の起動・停止、S2 で llama-swap 委譲（opt-in）。Agent 向け OpenAI 互換 Gateway はまだ無い（G1）。

Resident の `qwen-general` はこの daemon では起動も停止もしない。`qwen-worker` だけが `prepare` / idle `release` の対象。NSSM の ensure/stop には管理者権限が必要なことがある。

## 起動

リポジトリルートから:

```powershell
bun run dev
```

既定は `http://127.0.0.1:9810`。LAN にはバインドしない。既定の `config/runtimes.yaml` は NSSM。

```powershell
$env:LARM_CONFIG_DIR = "C:\Users\yuji\local-llm-setup\config"
$env:LARM_PORT = "9810"
$env:LARM_PREFERRED_IDLE_TTL_SECONDS = "60"
bun run dev
```

## 確認

```powershell
curl.exe http://127.0.0.1:9810/health
curl.exe http://127.0.0.1:9810/runtimes
curl.exe http://127.0.0.1:9810/state
curl.exe -sS -X POST http://127.0.0.1:9810/prepare -H "Content-Type: application/json" -d "{\"profile\":\"default\"}"
curl.exe -sS -X POST http://127.0.0.1:9810/resolve -H "Content-Type: application/json" -d "{\"capability\":\"llm.general\"}"
```

- `GET /health` → daemon 自身。Backend が COLD でも 200
- `GET /state` → `HOT` / `BUSY` / `COLD` などの観測
- `POST /prepare` → lease。すでに HOT なら 200、Preferred の起動が必要なら 202 + `operationId`
- `GET /operations/:id` → 202 の経過
- `POST /resolve` → HOT な endpoint。無ければ 503
- `POST /release` → lease 返却。lease が空なら TTL 後に worker を止めうる

Resident の起動・停止は従来どおり `start_servers.ps1` / `stop_servers.ps1`。

## llama-swap（S2、本番 NSSM とは同時に同じ 27B を動かさない）

```powershell
.\bin\llama-swap.exe --config config\llama-swap.yaml --listen 127.0.0.1:9292
```

Registry を切り替えるときは `config/runtimes.llama-swap.yaml` を雛形にする。手順の正本は [spec/milestone-2.md](../../spec/milestone-2.md)。daemon は llama-swap プロセスを自動起動しない。
