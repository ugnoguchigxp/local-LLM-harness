import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "@larm/core";
import { deriveStatus } from "@larm/core";
import { NssmBackend, parseScQuery } from "./nssm";
import { LifecycleError } from "./types";

function definition(port: number): RuntimeDefinition {
  return {
    id: "qwen-general",
    capability: ["llm.general"],
    backend: "nssm",
    node: "ai395-01",
    policy: { class: "resident" },
    resources: { estimatedMemoryGB: 24 },
    deployment: {
      service: "fake-llama",
      healthPort: port,
      endpoint: "http://127.0.0.1:9",
    },
  };
}

test("parseScQuery maps running and missing services", () => {
  expect(parseScQuery("STATE              : 4  RUNNING", "", 0)).toBe("Running");
  expect(parseScQuery("STATE              : 1  STOPPED", "", 0)).toBe("Stopped");
  expect(parseScQuery("", "The specified service does not exist as an installed service.", 1060)).toBe(
    "NotFound",
  );
});

test("HOT when /health returns status ok", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("no", { status: 404 });
    },
  });
  try {
    const backend = new NssmBackend([definition(server.port)], {
      queryService: async () => "Unknown",
    });
    const probe = await backend.health("qwen-general");
    expect(probe.healthOk).toBe(true);
    expect(probe.listening).toBe(true);
    expect(
      deriveStatus({ ...probe, startingGraceExpired: false }),
    ).toBe("HOT");
  } finally {
    server.stop(true);
  }
});

test("BUSY when fail_on_no_slot returns 503", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && url.searchParams.get("fail_on_no_slot") === "true") {
        return new Response("no slot", { status: 503 });
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("no", { status: 404 });
    },
  });
  try {
    const backend = new NssmBackend([definition(server.port)], {
      queryService: async () => "Running",
    });
    const probe = await backend.health("qwen-general");
    expect(probe.busy).toBe(true);
    expect(probe.healthOk).toBe(true);
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("BUSY");
  } finally {
    server.stop(true);
  }
});

test("STARTING when listening but health is not ok", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("loading", { status: 503 });
    },
  });
  try {
    const backend = new NssmBackend([definition(server.port)], {
      queryService: async () => "Running",
    });
    const probe = await backend.health("qwen-general");
    expect(probe.listening).toBe(true);
    expect(probe.healthOk).toBe(false);
    expect(deriveStatus({ ...probe, startingGraceExpired: false })).toBe("STARTING");
  } finally {
    server.stop(true);
  }
});

test("refuses to ensure or stop a resident runtime", async () => {
  const backend = new NssmBackend([definition(1)], {
    queryService: async () => "Stopped",
    control: {
      start: async () => {
        throw new Error("should not start");
      },
      stop: async () => {
        throw new Error("should not stop");
      },
    },
  });
  await expect(backend.ensure(definition(1))).rejects.toMatchObject({ code: "resident_protected" });
  await expect(backend.stop("qwen-general")).rejects.toBeInstanceOf(LifecycleError);
});

test("ensure starts backend then proxy for preferred runtimes", async () => {
  const started: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("no", { status: 404 });
    },
  });
  const worker: RuntimeDefinition = {
    id: "qwen-worker",
    capability: ["llm.general"],
    backend: "nssm",
    node: "ai395-01",
    policy: { class: "preferred" },
    resources: { estimatedMemoryGB: 24 },
    deployment: {
      service: "llama-qwen-27b-2-backend",
      proxyService: "llama-qwen-27b-2-proxy",
      healthPort: server.port,
      endpoint: "http://127.0.0.1:50041",
    },
  };
  try {
    const backend = new NssmBackend([worker], {
      queryService: async () => "Running",
      readyTimeoutMs: 2000,
      sleep: async () => undefined,
      control: {
        start: async (name) => {
          started.push(name);
        },
        stop: async (name) => {
          started.push(`stop:${name}`);
        },
      },
    });
    const probe = await backend.ensure(worker);
    expect(started).toEqual(["llama-qwen-27b-2-backend", "llama-qwen-27b-2-proxy"]);
    expect(probe.healthOk).toBe(true);
    await backend.stop("qwen-worker");
    expect(started).toEqual([
      "llama-qwen-27b-2-backend",
      "llama-qwen-27b-2-proxy",
      "stop:llama-qwen-27b-2-proxy",
      "stop:llama-qwen-27b-2-backend",
    ]);
  } finally {
    server.stop(true);
  }
});
