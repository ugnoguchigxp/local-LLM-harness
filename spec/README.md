# Specification

LARMの既存Markdown契約資料です。

新しい設計書・仕様書・実装計画は`../specs/`へHTML fragmentとして追加します。公開v1 APIと計画の正本はSpec HTMLであり、このdirectoryはcompatibility APIと実装詳細を補足します。

- [architecture.md](architecture.md): component境界とBackend
- [data-model.md](data-model.md): YAML registryとruntime state
- [api.md](api.md): control API
- [../specs/api.html](../specs/api.html): v1 Allocation・Gateway・Artifact APIの正本
- [../specs/concept.html](../specs/concept.html): Provider責務とモデル方針の正本
- [../specs/production-completion-plan.html](../specs/production-completion-plan.html): 現行のproduction完了計画
- [../specs/next-implementation-plan.html](../specs/next-implementation-plan.html): Milestone 15–21の履歴計画
- [../specs/implementation-completion.html](../specs/implementation-completion.html): Milestone 8–14の実装完了記録
- [../specs/implementation-completion-m15-m21.html](../specs/implementation-completion-m15-m21.html): Milestone 15–21の実装完了記録
- [../specs/commissioning-evidence.html](../specs/commissioning-evidence.html): gnosisの時刻固定preflightとcommissioning証跡
- [../specs/stable-release-gate.html](../specs/stable-release-gate.html): Stable昇格条件

production desired stateは[`../config/gnosis`](../config/gnosis)、model metadataは[`../deploy/gnosis/models.yaml`](../deploy/gnosis/models.yaml)、実機運用は[`../docs/gnosis.md`](../docs/gnosis.md)を参照してください。
