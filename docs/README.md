# Documentation

新規の設計書・仕様書・実装計画はrepository rootの`specs/`へSpec HTMLとして作成します。このdirectoryには互換案内と実機運用資料を残します。設計資料の入口と正本分類は[`../specs/overview.html`](../specs/overview.html)です。

| Document | Purpose |
| --- | --- |
| [../specs/concept.html](../specs/concept.html) | Providerの最新コンセプト、責務、過去計画の分類 |
| [../specs/api.html](../specs/api.html) | 実装済みv1 API contract |
| [../specs/implementation-plan.html](../specs/implementation-plan.html) | 初期実装の計画とコード完了記録 |
| [../specs/next-implementation-plan.html](../specs/next-implementation-plan.html) | Milestone 15–21の履歴計画 |
| [../specs/production-completion-plan.html](../specs/production-completion-plan.html) | 現行のnetwork境界、実機導入、SLO、canary完了計画 |
| [../specs/production-rollout-execution-plan.html](../specs/production-rollout-execution-plan.html) | Milestone 23–27のattended実行順、証跡、停止条件、rollback |
| [../specs/implementation-completion.html](../specs/implementation-completion.html) | Milestone 8–14の実装結果と残るattended gate |
| [../specs/implementation-completion-m15-m21.html](../specs/implementation-completion-m15-m21.html) | Milestone 15–21のrepository実装完了記録 |
| [../specs/commissioning-evidence.html](../specs/commissioning-evidence.html) | 時刻固定のlocal-node preflightとcommissioning証跡 |
| [../specs/saaa-maximum-performance-websocket.html](../specs/saaa-maximum-performance-websocket.html) | `saaa.llm-stream.v1`実装contract、repository証跡、残るcommissioning gate |
| [../specs/stable-release-gate.html](../specs/stable-release-gate.html) | Stable昇格のblocking gateとrollback方針 |
| [../specs/review-hardening.html](../specs/review-hardening.html) | 実装監査の指摘、修正、不変条件 |
| [../specs/documentation-review.html](../specs/documentation-review.html) | 文書監査の結果と正本対応表 |
| [local-node.md](local-node.md) | AI MAX+ 395実機の構成、計測、運用 |
| [asr-model-selection-2026-08-31.md](asr-model-selection-2026-08-31.md) | ASR候補の同一条件比較、Whisper HIP試用、Qwen rollback方針 |
| [../spec/README.md](../spec/README.md) | 既存Markdownのcompatibility API・architecture・data model |
| [../deploy/local-node/README.md](../deploy/local-node/README.md) | Linux配備手順 |
