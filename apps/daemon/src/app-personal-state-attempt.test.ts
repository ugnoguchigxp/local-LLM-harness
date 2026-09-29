import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ContextController } from "./context-controller";
import type { PersonalStateController } from "./personal-state-controller";
import { preparePersonalStateAttempt } from "./app-personal-state-attempt";

const startedAttempt = {
  attempt: { attemptId: "attempt_1", larmRequestId: "request_1", requestDigest: "digest", dataEpoch: 3 },
  signal: new AbortController().signal,
  replay: false,
};

async function requestAttempt(input: {
  attemptId?: string;
  protocol?: "openai.chat-completions.v1" | "openai.audio-transcriptions.v1";
  release?: string;
  chatRequest?: unknown;
  failBegin?: boolean;
  viewId?: string;
  scopedPrincipal?: string;
  onValue?: (value: Awaited<ReturnType<typeof preparePersonalStateAttempt>>) => Promise<unknown> | unknown;
}) {
  const events: unknown[] = [];
  const personalController = {
    beginAttempt: async (value: unknown) => {
      events.push(["begin", value]);
      if (input.failBegin) throw new Error("begin failed");
      return startedAttempt;
    },
    markAttemptForwarded: async (...args: unknown[]) => { events.push(["forwarded", ...args]); },
    finishAttempt: async (value: unknown) => { events.push(["terminal", value]); },
  } as unknown as PersonalStateController;
  const contextController = {
    viewPersonalStateBinding: (...args: unknown[]) => {
      events.push(["view", ...args]);
      return { requestDigest: "digest", dataEpoch: 3, sourceDigests: ["source_1"] };
    },
  } as unknown as ContextController;
  const app = new Hono();
  app.get("/", async (context) => {
    const result = await preparePersonalStateAttempt({
      context,
      protocol: input.protocol ?? "openai.chat-completions.v1",
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      allocationId: "allocation_1",
      runtime: "runtime_1",
      ...(input.release === undefined ? {} : { release: input.release }),
      ...(input.viewId === undefined ? {} : { contextViewId: input.viewId }),
      ...(input.scopedPrincipal === undefined ? {} : { scopedPrincipal: input.scopedPrincipal }),
      chatRequest: input.chatRequest ?? { messages: [] },
      principal: () => "api-principal",
      getFeature: () => ({
        controller: personalController,
        caller: { record: { principal: "provider-principal" } },
      } as never),
      getContextController: () => contextController,
      handleError: (_context, error) => context.json({ error: String(error) }, 409),
    });
    const value = await input.onValue?.(result);
    return value instanceof Response ? value : context.json({ result: result.ok, value });
  });
  const response = await app.request("/");
  return { response, events };
}

test("starts and finalizes a Personal State attempt with request/view evidence", async () => {
  const run = await requestAttempt({
    attemptId: "attempt_1",
    release: "release_1",
    viewId: "view_1",
    scopedPrincipal: "provider-principal",
    onValue: async (result) => {
      if (!result.ok) return;
      await result.value.onForwarded?.();
      await result.value.onTerminal?.({ outcome: "http_200", upstreamStatus: 200 });
      return {
        principal: result.value.principal,
        subjectDigest: result.value.subjectDigest,
        sourceDigests: result.value.sourceDigests,
      };
    },
  });

  expect(run.response.status).toBe(200);
  expect(await run.response.json()).toMatchObject({
    result: true,
    value: { principal: "provider-principal", sourceDigests: ["source_1"] },
  });
  expect(run.events.map((event) => (event as unknown[])[0])).toEqual([
    "begin", "view", "forwarded", "terminal",
  ]);
  expect(run.events[0]).toEqual(["begin", {
    principal: "provider-principal",
    attemptId: "attempt_1",
    allocationId: "allocation_1",
    runtime: "runtime_1",
    release: "release_1",
    viewId: "view_1",
    request: { messages: [] },
  }]);
  expect(run.events[2]).toEqual(["forwarded", expect.any(String), "attempt_1"]);
  expect(run.events[3]).toMatchObject(["terminal", {
    attemptId: "attempt_1",
    succeeded: true,
    cancelled: false,
    transportClosed: false,
    outcome: "http_200",
  }]);
});

test("rejects invalid attempt contracts before resolving Personal State", async () => {
  const run = await requestAttempt({
    attemptId: "bad id",
    release: "release_1",
    onValue: (result) => result.ok ? undefined : result.response,
  });

  expect(run.response.status).toBe(400);
  expect(await run.response.json()).toMatchObject({ error: { code: "personal_state_request_invalid" } });
  expect(run.events).toEqual([]);
});

test("maps attempt persistence errors through the route's Personal State error handler", async () => {
  const run = await requestAttempt({
    attemptId: "attempt_1",
    release: "release_1",
    failBegin: true,
    onValue: (result) => result.ok ? undefined : result.response,
  });

  expect(run.response.status).toBe(409);
  expect(await run.response.json()).toEqual({ error: "Error: begin failed" });
});
