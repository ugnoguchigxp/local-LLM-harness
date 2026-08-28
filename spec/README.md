# Specification

LARMの既存Markdown契約資料です。

新しい設計書・仕様書・実装計画は`../specs/`へHTML fragmentとして追加します。公開v1 APIと計画の正本はSpec HTMLであり、このdirectoryはcompatibility APIと実装詳細を補足します。

- [architecture.md](architecture.md): component境界とBackend
- [data-model.md](data-model.md): YAML registryとruntime state
- [api.md](api.md): control API
- [../specs/api.html](../specs/api.html): v1 Allocation・Gateway・Artifact APIの正本
- [../specs/concept.html](../specs/concept.html): Provider責務とモデル方針の正本
- [../specs/next-implementation-plan.html](../specs/next-implementation-plan.html): 次期実装計画の正本
- [../specs/implementation-completion.html](../specs/implementation-completion.html): Milestone 8–14の実装完了記録

production desired stateは[`../config/gnosis`](../config/gnosis)、model metadataは[`../deploy/gnosis/models.yaml`](../deploy/gnosis/models.yaml)、実機運用は[`../docs/gnosis.md`](../docs/gnosis.md)を参照してください。
