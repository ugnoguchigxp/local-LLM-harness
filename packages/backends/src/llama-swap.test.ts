import { expect, test } from "bun:test";
import { deriveStatus, type LlamaSwapRuntimeDefinition, type RuntimeDefinition } from "@larm/core";
import { LlamaSwapBackend, parseRunning } from "./llama-swap";
import { LifecycleError } from "./types";

function definition(listen: string, cls: "resident" | "preferred" = "preferred"): LlamaSwapRuntimeDefinition {
  return {
    id: cls === "resident" ? "qwen-general" : "qwen-worker",
    capability: ["llm.general"],
    protocol: "openai.chat-completions.v1",
    backend: "llama-swap",
    node: "ai395-01",
    policy: { class: cls },
    resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: {
      modelId: cls === "resident" ? "qwen-general" : "qwen-worker",
      listen,
      endpoint: listen,
      backendEndpoint: `${listen}/upstream/${cls === "resident" ? "qwen-general" : "qwen-worker"}`,
    },
  };
}

function fakeSwap(options: {
  states: Map<string, string>;
  loads?: string[];
  unloads?: string[];
  busy?: boolean;
}) {
  const loads = options.loads ?? [];
  const unloads = options.unloads ?? [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/running") {
        const running = [...options.states.entries()]
          .filter(([, state]) => state !== "stopped")
          .map(([model, state]) => ({ model, state }));
        return Response.json({ running });
      }
      const loadMatch = url.pathname.match(/^\/api\/models\/load\/([^/]+)$/);
      if (loadMatch && req.method === "POST") {
        const id = decodeURIComponent(loadMatch[1] ?? "");
        loads.push(id);
        options.states.set(id, "ready");
        return new Response("OK");
      }
      const unloadMatch = url.pathname.match(/^\/api\/models\/unload\/([^/]+)$/);
      if (unloadMatch && req.method === "POST") {
        const id = decodeURIComponent(unloadMatch[1] ?? "");
        unloads.push(id);
        options.states.set(id, "stopped");
        return new Response("OK");
      }
      const healthMatch = url.pathname.match(/^\/upstream\/([^/]+)\/health$/);
      if (healthMatch) {
        const id = decodeURIComponent(healthMatch[1] ?? "");
        if (options.states.get(id) !== "ready") {
          return new Response("loading", { status: 503 });
        }
        if (url.searchParams.get("fail_on_no_slot") === "true" && options.busy) {
          return new Response("no slot", { status: 503 });
        }
        return Response.json({ status: "ok" });
      }
      return new Response("no", { status: 404 });
    },
  });
  return { server, loads, unloads, listen: `http://127.0.0.1:${server.port}` };
}

test("parseRunning accepts array and legacy single-object shapes", () => {
  expect(parseRunning(`{"running":[{"model":"qwen-worker","state":"ready"}]}`)).toEqual([
    { model: "qwen-worker", state: "ready" },
  ]);
  expect(parseRunning(`{"model":"qwen-worker","state":"starting"}`)).toEqual([
    { model: "qwen-worker", state: "starting" },
  ]);
  expect(parseRunning("{}")).toEqual([]);
});

test("HOT when llama-swap reports ready and upstream health is ok", async () => {
  const fake = fakeSwap({ states: new Map([["qwen-worker", "ready"]]) });
  try {
    const backend = new LlamaSwapBackend([definition(fake.listen)]);
    const probe = await backend.health("qwen-worker");
    expect(probe.healthOk).toBe(true);
    expect(probe.listening).toBe(true);
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("HOT");
  } finally {
    fake.server.stop(true);
  }
});

test("BUSY when upstream fail_on_no_slot is 503", async () => {
  const fake = fakeSwap({
    states: new Map([["qwen-worker", "ready"]]),
    busy: true,
  });
  try {
    const backend = new LlamaSwapBackend([definition(fake.listen)]);
    const probe = await backend.health("qwen-worker");
    expect(probe.busy).toBe(true);
    expect(probe.healthOk).toBe(true);
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("BUSY");
  } finally {
    fake.server.stop(true);
  }
});

test("STARTING when llama-swap reports starting", async () => {
  const fake = fakeSwap({ states: new Map([["qwen-worker", "starting"]]) });
  try {
    const backend = new LlamaSwapBackend([definition(fake.listen)]);
    const probe = await backend.health("qwen-worker");
    expect(probe.healthOk).toBe(false);
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("STARTING");
  } finally {
    fake.server.stop(true);
  }
});

test("COLD when llama-swap itself is unreachable", async () => {
  const backend = new LlamaSwapBackend([definition("http://127.0.0.1:1")], {
    probeTimeoutMs: 200,
  });
  const probe = await backend.health("qwen-worker");
  expect(probe.service).toBe("Unknown");
  expect(probe.detail).toBe("llama-swap is unreachable");
  expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("COLD");
});

test("COLD when the model is not in /running", async () => {
  const fake = fakeSwap({ states: new Map() });
  try {
    const backend = new LlamaSwapBackend([definition(fake.listen)]);
    const probe = await backend.health("qwen-worker");
    expect(probe.service).toBe("Stopped");
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("COLD");
  } finally {
    fake.server.stop(true);
  }
});

test("refuses to ensure or stop a resident runtime", async () => {
  const fake = fakeSwap({ states: new Map() });
  try {
    const runtime = definition(fake.listen, "resident");
    const backend = new LlamaSwapBackend([runtime]);
    await expect(backend.ensure(runtime)).rejects.toMatchObject({ code: "resident_protected" });
    await expect(backend.stop("qwen-general")).rejects.toBeInstanceOf(LifecycleError);
  } finally {
    fake.server.stop(true);
  }
});

test("ensure loads a preferred model and stop unloads it", async () => {
  const fake = fakeSwap({ states: new Map([["qwen-worker", "stopped"]]) });
  try {
    const runtime = definition(fake.listen);
    const backend = new LlamaSwapBackend([runtime], {
      readyTimeoutMs: 2000,
      sleep: async () => undefined,
    });
    const probe = await backend.ensure(runtime);
    expect(fake.loads).toEqual(["qwen-worker"]);
    expect(probe.healthOk).toBe(true);
    await backend.stop("qwen-worker");
    expect(fake.unloads).toEqual(["qwen-worker"]);
    const after = await backend.health("qwen-worker");
    expect(after.healthOk).toBe(false);
    expect(after.service).toBe("Stopped");
  } finally {
    fake.server.stop(true);
  }
});

test("ensure propagates caller cancellation to llama-swap requests", async () => {
  const runtime = definition("http://127.0.0.1:9");
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const backend = new LlamaSwapBackend([runtime], {
    request: async (_url, init) => {
      requestSignal = init?.signal;
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("cancelled")),
          { once: true },
        );
      });
    },
  });
  const starting = backend.ensure(runtime, controller.signal);
  const reason = new Error("allocation released");
  controller.abort(reason);
  await expect(starting).rejects.toBe(reason);
  expect(requestSignal).toBe(controller.signal);
});

test("ignores systemd runtimes registered on this backend", async () => {
  const systemd: RuntimeDefinition = {
    id: "qwen-asr",
    capability: ["speech.stt"],
    protocol: "openai.audio-transcriptions.v1",
    backend: "systemd",
    node: "gnosis",
    policy: { class: "resident" },
    resources: { estimatedMemoryGB: 5, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: {
      service: "qwen-asr.service",
      healthPort: 8081,
      endpoint: "http://127.0.0.1:8081",
    },
  };
  const backend = new LlamaSwapBackend([systemd]);
  const listed = await backend.list();
  expect(listed).toEqual([]);
});
