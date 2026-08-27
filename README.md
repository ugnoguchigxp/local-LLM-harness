# local-llm-setup

AMD Ryzen AI MAX+ 395（統一メモリ 128GB）上のローカル AI 実行環境。Qwen 27B の NSSM 二重常駐に加え、Agent がそのまま繋ぐ **Local AI Provider**（コードネーム LARM）を構築中。

| | |
| --- | --- |
| コンセプト | [docs/CONCEPT.md](docs/CONCEPT.md) |
| 仕様 | [spec/README.md](spec/README.md) |
| S0（観測・完了） | [spec/milestone-0.md](spec/milestone-0.md) |
| S2（llama-swap・opt-in） | [spec/milestone-2.md](spec/milestone-2.md) |

現行の起動・停止はこれまでどおり `start_servers.ps1` / `stop_servers.ps1`。推論の公開面は当面 `proxy.js`（`:50043` / `:50041`）。次スライス **G1** で別ポートの OpenAI 互換 Gateway を足し、論理モデル名で話す。既定 Backend は NSSM。llama-swap への委譲は opt-in で、本番切替は Gateway のあと。

## 開発環境

| ツール | 入り方 | 確認 |
| --- | --- | --- |
| Bun 1.4 | `winget install --id Oven-sh.Bun` | 新しいターミナルで `bun --version` |
| NSSM | 既存の `bin\nssm.exe` | 追加インストール不要 |
| llama-swap v251（S2 実験） | `bin\llama-swap.exe`。無ければ GitHub release の `llama-swap_251_windows_amd64.zip` | `--listen 127.0.0.1:9292`。本番ポートは使わない |

依存関係（初回、および `package.json` を変えたあと）:

```powershell
bun install
bun run test
```

daemon（観測 + leases。`GET /health` `/runtimes` `/state`、`POST /prepare` `/resolve` `/release`）:

```powershell
bun run dev
```

別ターミナル:

```powershell
curl.exe http://127.0.0.1:9810/health
curl.exe http://127.0.0.1:9810/state
curl.exe -sS -X POST http://127.0.0.1:9810/resolve -H "Content-Type: application/json" -d "{\"capability\":\"llm.general\"}"
```

起動手順の詳細は [apps/daemon/README.md](apps/daemon/README.md)。`bun test` を引数なしで叩くと `atomic-llama-cpp-turboquant` 配下のテストまで拾うので、**`bun run test`** を使う。
