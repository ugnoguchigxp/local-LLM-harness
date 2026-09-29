import { expect, test } from "bun:test";
import type { ActiveContextView, Registry } from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";
import { finalizeActiveContextViewRequest } from "./context-request-finalization";

const runtime = {
  context: { class: "managed-context", outputReserveTokens: 32 },
  deployment: { endpoint: "http://runtime.test" },
} as unknown as Registry["runtimes"][number];

function view(overrides: Partial<ActiveContextView> = {}): ActiveContextView {
  return {
    state: "ready",
    inputBudgetTokens: 100,
    ...overrides,
  } as ActiveContextView;
}

function callbacks() {
  const events: string[] = [];
  return {
    events,
    callbacks: {
      clearMaterializing: () => events.push("clear"),
      updateOperation: (state: string, outcome?: string) => events.push(`${state}:${outcome ?? ""}`),
      onTokenizerUnavailable: (reason: string) => events.push(`tokenizer:${reason}`),
      onConsuming: () => {},
      onConsumed: (tokens: number) => events.push(`consumed:${tokens}`),
    },
  };
}

function finalize(input: {
  target?: ActiveContextView;
  request?: Record<string, unknown>;
  runtime?: Registry["runtimes"][number];
  inputSignal?: AbortSignal;
  deadlineSignal?: AbortSignal;
  materializationSignal?: AbortSignal;
  tokens?: number;
  maxBytes?: number;
  countChatTokens?: (
    endpoint: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<number>;
} = {}) {
  const events = callbacks();
  const request = input.request ?? { messages: [{ role: "user", content: "hello" }] };
  return {
    events,
    promise: finalizeActiveContextViewRequest({
      view: input.target ?? view(),
      request,
      runtime: input.runtime ?? runtime,
      ...(input.inputSignal ? { inputSignal: input.inputSignal } : {}),
      deadlineSignal: input.deadlineSignal ?? new AbortController().signal,
      materializationSignal: input.materializationSignal ?? new AbortController().signal,
      materializedMaxBytes: input.maxBytes ?? 8_192,
      countChatTokens: input.countChatTokens ?? (async () => input.tokens ?? 20),
    }, events.callbacks),
  };
}

test("finalizes a canonical request with the reserved output and consumes its view", async () => {
  const target = view();
  const run = finalize({ target });
  const prepared = await run.promise;

  expect(JSON.parse(new TextDecoder().decode(prepared)).max_tokens).toBe(32);
  expect(target.state).toBe("consumed");
  expect(run.events.events).toEqual(["clear", "succeeded:source_rebuild_materialized", "consumed:20"]);
});

test("rejects output above the reservation before tokenization", async () => {
  const target = view();
  const run = finalize({ target, request: { messages: [], max_tokens: 33 } });

  await expect(run.promise).rejects.toMatchObject({ code: "context_budget_exceeded" });
  expect(target.state).toBe("invalid");
  expect(run.events.events).toEqual(["clear", "failed:context_budget_exceeded"]);
});

test("canonical token count must fit the planned input budget", async () => {
  const target = view({ inputBudgetTokens: 10 });
  const run = finalize({ target, tokens: 11 });

  await expect(run.promise).rejects.toMatchObject({ code: "context_budget_exceeded" });
  expect(target.state).toBe("invalid");
  expect(run.events.events).toEqual(["clear", "failed:context_budget_exceeded"]);
});

test("tokenizer failure classifies cancellation and preserves the caller abort reason", async () => {
  const target = view();
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const run = finalize({
    target,
    inputSignal: controller.signal,
    materializationSignal: controller.signal,
    countChatTokens: async () => { throw new Error("aborted"); },
  });

  await expect(run.promise).rejects.toBe(reason);
  expect(target.state).toBe("invalid");
  expect(run.events.events).toEqual([
    "tokenizer:context_tokenizer_unavailable",
    "clear",
    "cancelled:context_materialization_cancelled",
  ]);
});

test("a runtime without managed-context policy is rejected", async () => {
  const run = finalize({ runtime: { context: undefined } as unknown as Registry["runtimes"][number] });

  await expect(run.promise).rejects.toBeInstanceOf(ContextControllerError);
  expect(run.events.events).toEqual(["clear", "failed:context_view_stale"]);
});
