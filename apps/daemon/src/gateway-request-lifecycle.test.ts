import { expect, test } from "bun:test";
import type { RuntimeProtocol } from "@larm/core";
import type { VerifiedProviderToken } from "./agent-connection-controller";
import { beginGatewayProviderRequest } from "./gateway-request-lifecycle";

function scoped(errorCode?: string): VerifiedProviderToken {
  return {
    record: {
      id: "connection-1",
      allocationId: "allocation-1",
      principal: "principal-1",
      ...(errorCode ? { error: { code: errorCode } } : {}),
    },
    provider: {
      capability: "llm.general",
      protocol: "openai.chat-completions.v1",
      publicModel: "model",
    },
  } as unknown as VerifiedProviderToken;
}

test("provider request retains and releases allocation and connection references exactly once", () => {
  const events: string[] = [];
  const request = beginGatewayProviderRequest({
    allocationId: "allocation-1",
    capability: "llm.general",
    protocol: "openai.chat-completions.v1",
    bodyMode: "buffered",
    scoped: scoped(),
    random: () => "fixed",
    connections: {
      beginProviderRequest: (connectionId: string, requestId: string, protocol: RuntimeProtocol, extendIdle: boolean) => {
        events.push(`begin:${connectionId}:${requestId}:${protocol}:${extendIdle}`);
        return true;
      },
      finishProviderRequest: (connectionId: string, requestId: string) => events.push(`finish:${connectionId}:${requestId}`),
    } as never,
    control: {
      retainProviderRequest: (allocationId: string, capability: string, requestId: string) => {
        events.push(`retain:${allocationId}:${capability}:${requestId}`);
        return "instance-1";
      },
      releaseProviderRequest: (instanceId: string | undefined, requestId: string) => events.push(`release:${instanceId}:${requestId}`),
    } as never,
  });

  expect(request.ok).toBe(true);
  if (!request.ok) return;
  expect(request.requestId).toBe("provider-request-fixed");
  expect(request.providerInstanceId).toBe("instance-1");
  request.release();
  request.release();
  expect(events).toEqual([
    "begin:connection-1:provider-request-fixed:openai.chat-completions.v1:true",
    "retain:allocation-1:llm.general:provider-request-fixed",
    "release:instance-1:provider-request-fixed",
    "finish:connection-1:provider-request-fixed",
  ]);
});

test("inactive scoped requests do not retain an allocation and distinguish idle release", () => {
  let retained = false;
  const base = {
    allocationId: "allocation-1",
    capability: "llm.general",
    protocol: "openai.chat-completions.v1" as const,
    bodyMode: "buffered" as const,
    control: { retainProviderRequest: () => { retained = true; return undefined; } } as never,
    connections: {
      beginProviderRequest: () => false,
      finishProviderRequest: () => undefined,
    } as never,
  };
  expect(beginGatewayProviderRequest({ ...base, scoped: scoped("foreground_idle_timeout") }))
    .toMatchObject({ ok: false, code: "connection_idle_released" });
  expect(beginGatewayProviderRequest({ ...base, scoped: scoped("connection_inactive") }))
    .toMatchObject({ ok: false, code: "connection_inactive" });
  expect(retained).toBe(false);
});

test("voice catalog probes do not extend connection idle time", () => {
  let extendIdle: boolean | undefined;
  const request = beginGatewayProviderRequest({
    allocationId: "allocation-1",
    capability: "speech.tts",
    protocol: "openai.audio-speech.v1",
    bodyMode: "none",
    scoped: scoped(),
    connections: {
      beginProviderRequest: (_id: string, _requestId: string, _protocol: RuntimeProtocol, extend: boolean) => { extendIdle = extend; return true; },
      finishProviderRequest: (_id: string, _requestId: string) => undefined,
    } as never,
    control: {} as never,
  });
  expect(request.ok).toBe(true);
  expect(extendIdle).toBe(false);
});
