# 仕様

実装の正本。コンセプトは [docs/CONCEPT.md](../docs/CONCEPT.md) を先に読む。

| 文書 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 責務境界、決定事項、パッケージ構成 |
| [data-model.md](./data-model.md) | Node / Runtime / State / Lease / Logical Model |
| [api.md](./api.md) | HTTP API。実装済みと次スライス（Gateway）を明示 |
| [milestone-0.md](./milestone-0.md) | S0 観測（完了）。歴史的正本 |
| [milestone-2.md](./milestone-2.md) | llama-swap 委譲（opt-in）。本番切替は G1 のあと |

矛盾がある場合の優先順位:

1. 本 `spec/` の当該マイルストーン範囲
2. `docs/CONCEPT.md` の原則
3. 現行 PowerShell / `proxy.js` 運用（本番推論経路は Gateway が同等になるまで壊さない）

S0（観測）と S1（leases / Preferred の制御 / 副作用なし resolve）は実装済み。次は **G1**（別ポートの OpenAI 互換 Gateway。起動はしない）である。
