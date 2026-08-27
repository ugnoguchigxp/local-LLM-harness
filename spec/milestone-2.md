# Milestone S2 — llama-swap 委譲

LLM のプロセス寿命を llama-swap に渡す。Control Plane は Desired HOT 集合だけを送り、swap solver は TypeScript で書かない。本番の NSSM Qwen は、実験が終わるまで止めない。**本番切替は G1 Gateway のあと**（[docs/CONCEPT.md](../docs/CONCEPT.md) ロードマップ）。

正本の原則は [docs/CONCEPT.md](../docs/CONCEPT.md)。配置は [architecture.md](./architecture.md)。YAML は [data-model.md](./data-model.md)。

---

## 1. ゴール

1. Registry が `backend: llama-swap` と nssm を同じファイルで区別できる
2. LlamaSwapBackend が `/running` と upstream `/health` から HOT / BUSY / STARTING / COLD を出す
3. Preferred の `ensure` / `stop` が load / unload になり、Resident は拒否する
4. daemon は Runtime ごとに Backend を振り分ける。既定 `config/runtimes.yaml` は nssm のまま
5. llama-swap 用の example config は `:50051` / `:50053` を使わない
6. 実験クライアントは llama-swap の `/v1` を直接叩いてよい。それは **upstream** である。Agent 向けの公開 OpenAI 面は G1 の Gateway に置く。S2 で `generate()` や第二の swap solver は書かない

---

## 2. 範囲

### やる

- Zod discriminated union（`nssm` | `llama-swap`）
- LlamaSwapBackend + RoutingBackend
- `config/llama-swap.yaml` と `config/runtimes.llama-swap.yaml`
- 偽 HTTP の unit test。27B をテストでロードしない
- 手元に llama-swap バイナリを置く手順

### やらない

- 本番 `runtimes.yaml` を llama-swap に切り替える
- PowerShell / NSSM サービス定義の削除
- daemon からの llama-swap プロセス自動起動
- STT / ProcessBackend（S3）
- llama-swap matrix の再実装
- Agent 向け Gateway（それは G1。S2 より先に公開面を置く）

---

## 3. 実験手順（本番を触らない）

1. `bin\llama-swap.exe --config config\llama-swap.yaml --listen 127.0.0.1:9292`
2. 別ディレクトリまたはコピーした `runtimes.yaml` で `backend: llama-swap` にする（`config/runtimes.llama-swap.yaml` が雛形）
3. `bun run dev` して `GET /state` が COLD から、worker の `prepare` で STARTING / HOT になることを見る
4. うまくいったあとで初めて NSSM の Qwen を止めて切り替える

Resident の `qwen-general` は Manager から load しない。llama-swap 側の preload も付けない。
