# local-llm-setup

AMD Ryzen AI MAX+ 395（統一メモリ 128GB）上のローカル AI 実行環境。Windows/NSSM と Ubuntu/systemd の両方を RuntimeBackend 越しに扱い、Agent がそのまま繋ぐ **Local AI Provider**（コードネーム LARM）を構築中。

| | |
| --- | --- |
| コンセプト | [docs/CONCEPT.md](docs/CONCEPT.md) |
| 仕様 | [spec/README.md](spec/README.md) |
| S0（観測・完了） | [spec/milestone-0.md](spec/milestone-0.md) |
| S2（llama-swap・opt-in） | [spec/milestone-2.md](spec/milestone-2.md) |
| gnosis（Ubuntu/gfx1151） | [docs/gnosis.md](docs/gnosis.md) |
| gnosis 配備ファイル | [deploy/gnosis/README.md](deploy/gnosis/README.md) |

Windows の起動・停止はこれまでどおり `start_servers.ps1` / `stop_servers.ps1`。gnosis は `deploy/gnosis/systemd` と `config/gnosis` を正本にする。次スライス **G1** で OpenAI 互換 Gateway を足し、論理モデル名で話す。それまでは各 Runtime のポートを直接利用する。

モデル本体は Git 管理しない。`deploy/gnosis/models.yaml` は取得元と `/srv/ai/models` 上の配置先だけを管理する。

## 開発環境

| ツール | 入り方 | 確認 |
| --- | --- | --- |
| Bun 1.4 | `winget install --id Oven-sh.Bun` | 新しいターミナルで `bun --version` |
| NSSM | 既存の `bin\nssm.exe` | 追加インストール不要 |
| llama-swap v251（S2 実験） | `bin\llama-swap.exe`。無ければ GitHub release の `llama-swap_251_windows_amd64.zip` | `--listen 127.0.0.1:9292`。本番ポートは使わない |

gnosis では Bun 1.4、systemd、llama-swap v251 を使う。導入・検証手順は [deploy/gnosis/README.md](deploy/gnosis/README.md) を参照。

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
