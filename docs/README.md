# Local AI Provider — ドキュメント

Agent Harness がそのまま繋ぐ Local LLM Provider の文書一式。内部では Runtime の常駐・起動・選択を管理する。コードネームは LARM。

| 文書 | 内容 |
| --- | --- |
| [CONCEPT.md](./CONCEPT.md) | なぜ作るか、何を守るか、何を作らないか。北極星 |
| [../spec/README.md](../spec/README.md) | 仕様の入口。データモデル、API、マイルストーン計画 |
| [gnosis.md](./gnosis.md) | Ubuntu/gfx1151 の実配備、ベンチマーク、運用 |

現行の NSSM / PowerShell 運用（`start_servers.ps1`、`proxy.js`）と gnosis の systemd 運用は、Gateway が統合するまでの **現行 Data Plane** として残す。制御 API（`/state` `/prepare` 等）は副経路である。Agent から見た主契約は OpenAI 互換 Gateway とする。
