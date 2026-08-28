# Control API

daemonの既定listenは`127.0.0.1:9810`です。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | daemon自身のhealth |
| GET | `/runtimes` | registry定義 |
| GET | `/runtimes/:id` | Runtime定義 |
| GET | `/state` | 最終観測snapshot |
| POST | `/prepare` | capability/profile leaseを追加 |
| GET | `/operations/:id` | 非同期prepareの状態 |
| POST | `/resolve` | HOT/BUSY Runtimeを解決 |
| POST | `/release` | leaseを返却 |

## Prepare

```json
{"profile":"voice","client":"ambient"}
```

すでにreadyなら`200`、起動処理を開始した場合は`202`と`operationId`、満たせないcapabilityは`409`を返します。

## Resolve

```json
{"capability":"llm.general"}
```

選択できた場合はRuntime id、node、endpoint、statusを返します。Registryに能力がなければ`404`、Runtimeがreadyでなければ`503`です。`resolve`自体はlifecycleを変更しません。

## Release

```json
{"leaseId":"lease_example"}
```

lease返却後もResidentは停止しません。Preferredは他のleaseとidle TTLを考慮して停止できます。
