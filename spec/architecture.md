# Architecture

## Components

```text
apps/daemon          Allocation API、LLM・STT・TTS Gateway、execution gate、観測loop、operation coordination
packages/core        registry、Route、Allocation、admission、planner、resolve
packages/backends    systemd、llama-swap、artifact store
config/gnosis        production desired state
deploy/gnosis        host setup、systemd units、artifact manifest
```

CoreはOS非依存の選択・状態計算に限定し、推論本文を処理しません。daemonのGatewayは
Allocationへ固定された`deployment.endpoint`だけへprotocol-awareにHTTPをproxyします。Runtime別の
同時実行slotとbounded queueを通り、実行直前にAllocationと観測状態を再検証します。最新の公開contractは
[`../specs/api.html`](../specs/api.html)を参照してください。

## RuntimeBackend

```ts
interface RuntimeBackend {
  list(): Promise<RuntimeHealth[]>;
  health(runtimeId: string): Promise<RuntimeHealth>;
  ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeHealth>;
  stop(runtimeId: string): Promise<void>;
}
```

`AbortSignal`はAllocation release、TTL、startup deadline、daemon drainをBackendの起動待機まで伝播します。`stop`はidle reconciliationまたは明示的な配備操作から呼ばれ、ResidentではBackendが拒否します。

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

Desired capabilityはactive leaseとAllocationの和集合にResidentが提供する能力を加えたものです。
v1 AllocationはRoute選択結果を期限付きBindingへ固定します。`prepare`と`release`は互換adapterとして
内部Allocationを利用します。Residentは常に保護し、Preferredだけを明示Routeとidle policyの対象にします。
