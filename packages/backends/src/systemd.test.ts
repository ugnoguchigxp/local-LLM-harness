import { expect, test } from "bun:test";
import type { SystemdRuntimeDefinition } from "@larm/core";
import { SystemdBackend, parseSystemctlState } from "./systemd";

function definition(
  port: number,
  cls: "resident" | "preferred" = "preferred",
): SystemdRuntimeDefinition {
  return {
    id: cls === "resident" ? "qwen-asr" : "qwen-tts",
    capability: [cls === "resident" ? "speech.stt" : "speech.tts.expressive"],
    protocol: cls === "resident"
      ? "openai.audio-transcriptions.v1"
      : "openai.audio-speech.v1",
    backend: "systemd",
    node: "local-node",
    policy: { class: cls },
    resources: { estimatedMemoryGB: 5, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: {
      service: `${cls === "resident" ? "qwen-asr" : "qwen-tts"}.service`,
      healthPort: port,
      endpoint: `http://127.0.0.1:${port}`,
    },
  };
}

test("parseSystemctlState maps systemd states", () => {
  expect(parseSystemctlState("active\n", "", 0)).toBe("Running");
  expect(parseSystemctlState("activating\n", "", 3)).toBe("Running");
  expect(parseSystemctlState("inactive\n", "", 3)).toBe("Stopped");
  expect(parseSystemctlState("failed\n", "", 3)).toBe("Stopped");
  expect(parseSystemctlState("unknown\n", "Unit x.service could not be found", 4)).toBe(
    "NotFound",
  );
});

test("health accepts healthy status from a running systemd service", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ status: "healthy" });
    },
  });
  try {
    const backend = new SystemdBackend([definition(server.port!)], {
      queryService: async () => "Running",
    });
    const health = await backend.health("qwen-tts");
    expect(health.service).toBe("Running");
    expect(health.listening).toBe(true);
    expect(health.healthOk).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("preferred systemd runtime starts and stops through systemctl control", async () => {
  const actions: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ status: "ok" });
    },
  });
  const runtime = definition(server.port!);
  try {
    const backend = new SystemdBackend([runtime], {
      queryService: async () => "Running",
      control: {
        start: async (service) => {
          actions.push(`start:${service}`);
        },
        stop: async (service) => {
          actions.push(`stop:${service}`);
        },
      },
      sleep: async () => undefined,
    });
    const health = await backend.ensure(runtime);
    expect(health.healthOk).toBe(true);
    await backend.stop(runtime.id);
    expect(actions).toEqual(["start:qwen-tts.service", "stop:qwen-tts.service"]);
  } finally {
    server.stop(true);
  }
});

test("resident systemd runtime is lifecycle protected", async () => {
  const runtime = definition(1, "resident");
  const backend = new SystemdBackend([runtime], {
    queryService: async () => "Running",
    control: {
      start: async () => {
        throw new Error("should not start");
      },
      stop: async () => {
        throw new Error("should not stop");
      },
    },
  });
  await expect(backend.ensure(runtime)).rejects.toMatchObject({ code: "resident_protected" });
  await expect(backend.stop(runtime.id)).rejects.toMatchObject({ code: "resident_protected" });
});

test("ensure stops before health polling when caller cancellation follows start", async () => {
  const runtime = definition(1);
  const controller = new AbortController();
  const reason = new Error("allocation expired");
  let starts = 0;
  let receivedSignal: AbortSignal | undefined;
  const backend = new SystemdBackend([runtime], {
    control: {
      start: async (_service, signal) => {
        starts += 1;
        receivedSignal = signal;
        controller.abort(reason);
      },
      stop: async () => undefined,
    },
  });
  await expect(backend.ensure(runtime, controller.signal)).rejects.toBe(reason);
  expect(starts).toBe(1);
  expect(receivedSignal).toBe(controller.signal);
});
