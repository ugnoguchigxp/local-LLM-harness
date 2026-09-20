import { expect, test } from "bun:test";
import { GatewayLifecycle } from "./gateway-lifecycle";

test("gateway stays not-ready until the bound listener is verified", () => {
  const transitions: unknown[] = [];
  const lifecycle = new GatewayLifecycle({
    bootEpoch: "epoch-test",
    configRevision: "revision-test",
    now: () => 1_789_920_000_000,
    onTransition: (transition) => transitions.push(transition),
  });

  expect(lifecycle.snapshot()).toMatchObject({ state: "starting", ready: false });
  lifecycle.listenerBound("http://0.0.0.0:9810");
  expect(lifecycle.snapshot()).toMatchObject({ state: "verifying", ready: false });
  lifecycle.listenerVerified();
  expect(lifecycle.snapshot()).toMatchObject({ state: "ready", ready: true });
  expect(transitions).toEqual([
    expect.objectContaining({ from: "starting", to: "verifying", reason: "listener_bound" }),
    expect.objectContaining({ from: "verifying", to: "ready", reason: "listener_verified" }),
  ]);
});

test("drain is a one-way not-ready transition and failed verification never publishes ready", () => {
  const lifecycle = new GatewayLifecycle({
    bootEpoch: "epoch-test",
    configRevision: "revision-test",
  });
  lifecycle.listenerBound("http://0.0.0.0:9810");
  lifecycle.listenerVerificationFailed("model_route_missing");
  expect(lifecycle.snapshot()).toMatchObject({
    state: "failed",
    ready: false,
    reason: "model_route_missing",
  });
  expect(() => lifecycle.listenerVerified()).toThrow("failed");

  const ready = new GatewayLifecycle({
    bootEpoch: "epoch-test-2",
    configRevision: "revision-test-2",
  });
  ready.listenerBound("http://0.0.0.0:9810");
  ready.listenerVerified();
  ready.beginDrain("SIGTERM");
  expect(ready.snapshot()).toMatchObject({ state: "draining", ready: false, reason: "SIGTERM" });
  expect(() => ready.listenerVerified()).toThrow("draining");
});
