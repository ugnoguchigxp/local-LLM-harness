# Milestone S0 — 観測（完了）

最初のマイルストーン。動いている Qwen 2 本を **止めずに** Registry と State として可視化した。北極星の更新（Provider / Gateway 主契約）は [docs/CONCEPT.md](../docs/CONCEPT.md) を正とする。本ファイルは S0 の歴史的正本である。

正本の原則は [docs/CONCEPT.md](../docs/CONCEPT.md)。型と YAML は [data-model.md](./data-model.md)。HTTP は [api.md](./api.md)。配置は [architecture.md](./architecture.md)。

---

## 1. ゴール

1. 現行 NSSM の 2 Runtime を YAML で宣言できる
2. daemon がそれを読み、HTTP で返す
3. 実際の `/health` を見て `COLD` / `STARTING` / `HOT` / `BUSY` / `FAILED` が分かる
4. Core の Registry と状態判定は Hono 無しで単体テストできる
5. 既存の start / stop / proxy / メモリ監視を変更しない

完了時、次が手元で通る。

```bash
curl http://127.0.0.1:9810/health
curl http://127.0.0.1:9810/runtimes
curl http://127.0.0.1:9810/state
```

`GET /state` の `qwen-general` / `qwen-worker` が、サービスが上がっていれば `HOT` または `BUSY`、`stop_servers.ps1` 後なら `COLD` になる。

---

## 2. 範囲

### やる

- Bun workspace（`apps/daemon`, `packages/core`, `packages/backends`）
- Zod + YAML の Registry ロード
- `config/nodes.yaml` / `runtimes.yaml` / `profiles.yaml`（本マシンの実サービス名）
- NssmBackend の `list` / `health`（Windows サービス照会は補助、HTTP が一次）
- 観測ループと `GET /health` `/runtimes` `/state` `/runtimes/:id`
- `POST /prepare` `/release` `/resolve` の 501
- Core の unit test（YAML fixture + 偽 health）
- daemon の起動手順（README 短文）

### やらない

- サービスの start / stop / restart
- llama-swap の導入
- leases / planner / scheduler
- OpenAI 互換ゲートウェイ
- 実メモリ／VRAM サンプリング
- LAN bind（`0.0.0.0`）
- STT / VAD / 音声 Resident
- 既存 `.ps1` の書き換え、NSSM 再登録
- SQLite
- UI（WPF ダッシュボードは触らない）

---

## 3. 完成時のツリー

```text
apps/daemon/
  package.json
  src/main.ts              listen、観測ループ、Hono 配線
  src/app.ts               ルート定義（テストから import 可能）
packages/core/
  package.json
  src/index.ts
  src/schema.ts            Zod（Node, RuntimeDefinition, ClusterState）
  src/registry.ts          YAML → Registry
  src/status.ts            health/listen/service → RuntimeStatus
  src/state.ts             snapshots を束ねて ClusterState にする
packages/backends/
  package.json
  src/types.ts             RuntimeBackend, RuntimeHealth
  src/nssm.ts              list/health。ensure/stop は not implemented
config/
  nodes.yaml
  runtimes.yaml
  profiles.yaml
package.json               bun workspaces
tsconfig.json
README.md                  リポジトリ入口から daemon の起動だけ追記、または apps/daemon/README.md
```

既存の `plan.md` や PowerShell は残す。Manager 用の説明は `docs/` と `spec/` を指す。

パッケージ名の初期案:

- `@larm/core`
- `@larm/backends`
- `@larm/daemon`（private）

公開 npm はまだ考えない。

---

## 4. 作業パッケージ

順序通りに進める。後のパッケージは前の test が緑になってから。

### W1. ワークスペース骨格

- ルート `package.json` に `"workspaces": ["apps/*", "packages/*"]`
- Bun で TypeScript。テストは `bun test`
- `packages/core` が `hono` も `apps/daemon` も import しないことをパッケージ依存で保証する

**完了:** `bun test` が空でも走ること。

### W2. Schema と YAML ロード

- [data-model.md](./data-model.md) のフィールドを Zod にする
- 本マシン用 YAML 3 ファイルを `config/` に置く（内容は data-model の例と一致）
- 不正 YAML（class 欠落、未知 backend、存在しない node 参照）でロード失敗
- fixture YAML での unit test

**完了:** 実 `config/runtimes.yaml` を読み、`qwen-general` が resident、`qwen-worker` が preferred と断言できるテスト。

### W3. 状態判定（純粋関数）

入力の例:

```ts
{
  service: "Running" | "Stopped" | "NotFound" | "Unknown",
  listening: boolean,
  healthOk: boolean,
  busy: boolean,          // fail_on_no_slot が 503
  startingGraceExpired: boolean
}
```

出力は `RuntimeStatus`。表は [architecture.md](./architecture.md) に従い、テストで全組み合わせを固定する。

**完了:** `status.ts` の表テスト。HTTP も NSSM も mock。

### W4. NssmBackend

- `deployment.healthPort` へ `GET /health` と `GET /health?fail_on_no_slot=true`
- TCP listen 確認（`127.0.0.1` のみ）
- 可能なら `sc query` または同等でサービス状態。失敗したら `Unknown`
- タイムアウトは短く（1–2 秒）。観測ループを止めない
- `ensure` / `stop` は throw または `not_implemented`

Windows 以外では NssmBackend を初期化しなくてよい。CI が Linux なら W3 の純粋関数テストだけを必須にし、W4 は実機確認とする。

**完了:** 偽 HTTP サーバを立てた integration test（Bun で localhost に health を返す）で HOT / BUSY / STARTING を区別。

### W5. daemon HTTP

- Hono で [api.md](./api.md) の S0 ルート
- 起動時に `config/` を読む（パスは CLI 引数または環境変数 `LARM_CONFIG_DIR`、既定はリポジトリの `config/`）
- 観測ループ 2 秒
- `POST /prepare` 等は 501
- ログに API キーを出さない

**完了:** `bun test` で `app.ts` に対する HTTP テスト（Backend を stub）。

### W6. 実機確認と文書

- 本マシンで daemon を起動し、2 本 HOT のときに `GET /state` を記録
- 片方の backend を止めたときの差分（可能なら。S0 は自分では止めないので、確認は手動でサービスを Stop してよい。確認後に元に戻す）
- `apps/daemon/README.md` に起動コマンド
- ルート README が無ければ、`docs/README.md` へのポインタだけ短い `README.md` を追加

**完了:** 受け入れチェックリスト（本ファイル §6）をすべて満たす。

---

## 5. 実装上の拘束

1. **本番を止めるコードをマージしない。** `Start-Service` / `nssm start|stop` / `Stop-Process` を NssmBackend に書かない。
2. **Core に `node:child_process` や `sc.exe` を置かない。** OS 照会は `packages/backends`。
3. **推定メモリと観測メモリを混ぜない。** S0 の JSON に出すのは YAML の `estimatedMemoryGB` と Node の宣言値まで。
4. **proxy ポートではなく healthPort で HOT を判定する。** proxy は busy を 503 にする層であり、モデルロード完了の定義は llama-server の `/health`。
5. **STARTING をすぐ FAILED にしない。** 猶予 300 秒は現行 `Wait-LlmHttpHealth` に合わせる。

---

## 6. 受け入れ

手動（本マシン、Qwen 2 本が通常運転のとき）:

| # | 確認 |
| --- | --- |
| A1 | `GET /health` が 200 `{ "status": "ok" }` |
| A2 | `GET /runtimes` に `qwen-general` と `qwen-worker` があり、class がそれぞれ resident / preferred |
| A3 | `GET /state` で両者の `endpoint` が `:50043` と `:50041`、`status` が `HOT` または `BUSY` |
| A4 | `GET /runtimes/does-not-exist` が 404 |
| A5 | `POST /prepare` が 501 |
| A6 | daemon 起動中も既存クライアントが `:50043` で推論できる（回帰） |
| A7 | `bun test` が CI 相当（少なくとも Core）で緑 |

自動:

| # | 確認 |
| --- | --- |
| T1 | 不正 YAML で Registry ロードが失敗する |
| T2 | health ok → HOT、503 busy → BUSY、listen のみ → STARTING、stopped → COLD |
| T3 | grace 切れ + Running + health 失敗 → FAILED |
| T4 | stub Backend で `/state` の JSON 形が Zod を通る |

---

## 7. リスク

| リスク | 扱い |
| --- | --- |
| `sc query` に管理者権限が要る | HTTP を一次ソースにする。サービス状態は Unknown でも S0 は成立 |
| ロード中 300 秒 FAIL に落とすと誤検知 | grace を現行スクリプトと同じ 300 秒にする |
| `fail_on_no_slot` の挙動差 | 503 以外は BUSY にしない。不明なら HOT/STARTING 側に倒す |
| Bun の Windows ネットワーク | W4 の localhost integration で先に潰す |
| ルートがスクリプト置き場で汚い | Manager は `apps/` `packages/` `config/` `docs/` `spec/` に閉じる。既存 `.ps1` は移動しない |

---

## 8. S0 の先（実装しない。境界を示す）

S1 で足すもの:

- lease ストア（メモリ）
- `POST /prepare` / `POST /release`（非同期または長めの同期）
- NssmBackend.ensure / stop。対象は **qwen-worker のみ**。`qwen-general` への stop は API でも拒否
- `POST /resolve`（副作用なし、HOT 優先）

S1 に入る条件: 本マイルストーンの受け入れがすべて緑であること。S0 の daemon を止めずに S1 を足せること。
