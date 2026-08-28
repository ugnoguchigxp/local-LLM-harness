# Architecture

## Components

```text
apps/daemon          HTTP control API、観測loop、Backend routing
packages/core        registry、state、leases、planner、resolve
packages/backends    systemd、llama-swap
config/gnosis        production desired state
deploy/gnosis        host setup、systemd units、artifact manifest
```

Coreはcontrol planeに限定し、推論本文を処理しません。将来のGatewayはCoreが選んだ`deployment.endpoint`へHTTPをproxyします。

## RuntimeBackend

```ts
interface RuntimeBackend {
  list(): Promise<RuntimeHealth[]>;
  health(runtimeId: string): Promise<RuntimeHealth>;
  ensure(runtime: RuntimeDefinition): Promise<RuntimeHealth>;
  stop(runtimeId: string): Promise<void>;
}
```

### SystemdBackend

Linux serviceを扱います。HTTP `/health`をHOT/BUSY判定の一次ソース、`systemctl is-active`をCOLD/STARTING/FAILEDの補助情報とします。

- Residentへの`ensure`と`stop`は拒否
- Preferredの操作は`systemctl start/stop`へ委譲
- 権限がない環境ではhealth観測だけを利用可能

### LlamaSwapBackend

llama-swap配下のmodel lifecycleを扱います。llama-swap process自体はsystemdが管理します。

- `/running`と`/upstream/{modelId}/health`を観測
- Preferredのload/unloadをllama-swap APIへ委譲
- matrix、TTL、preloadのsolverはllama-swap側に残す

## Desired state

Desired capabilityはactive leaseの和集合にResidentが提供する能力を加えたものです。`prepare`はleaseを追加し、`release`は返却します。Residentは常に保護し、空きがある限りPreferredを急いで停止しません。
