export type StabilityResult = {
  schemaVersion: 1;
  kind: "qwen-agent-worker-stability";
  baseUrl: string;
  model: string;
  startedAt: string;
  completedAt: string;
  bootEpoch: string;
  configRevision: string;
  requested: number;
  succeeded: number;
  failed: number;
  tcpConnectErrors: number;
  latencyMs: { min: number; p50: number; p95: number; p99: number; max: number } | null;
};

export type StabilityOptions = {
  baseUrl: string;
  token: string;
  model?: string;
  requests?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  monotonicNow?: () => number;
};

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(`${current.name}:${current.message}`);
      current = current.cause;
    } else if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const field of ["code", "name", "message"]) {
        if (typeof record[field] === "string") parts.push(record[field]);
      }
      current = record.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ");
}

export function isTcpConnectError(error: unknown): boolean {
  return /(?:connect|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|HostUnreachable|No route to host)/i
    .test(errorChain(error));
}

export async function runQwenAgentWorkerStability(
  options: StabilityOptions,
): Promise<StabilityResult> {
  const requests = options.requests ?? 100;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(requests) || requests < 1 || requests > 10_000) {
    throw new Error("requests must be an integer from 1 through 10000");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7_200_000) {
    throw new Error("timeoutMs must be an integer from 1 through 7200000");
  }
  if (!options.token) throw new Error("LARM_TOKEN is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const model = options.model ?? "qwen-agent-worker";
  const headers = { authorization: `Bearer ${options.token}` };
  const startedAt = new Date(now()).toISOString();

  const healthResponse = await fetchImpl(`${baseUrl}/health`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!healthResponse.ok) throw new Error(`health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json() as {
    status?: string;
    ready?: boolean;
    bootEpoch?: string;
    configRevision?: string;
  };
  if (health.status !== "ok" || health.ready === false || !health.bootEpoch || !health.configRevision) {
    throw new Error("health did not report a ready identified generation");
  }

  const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!modelsResponse.ok) throw new Error(`models returned HTTP ${modelsResponse.status}`);
  const models = await modelsResponse.json() as { data?: Array<{ id?: string }> };
  if (!models.data?.some((entry) => entry.id === model)) {
    throw new Error(`model ${model} is not registered`);
  }

  let succeeded = 0;
  let failed = 0;
  let tcpConnectErrors = 0;
  const latencies: number[] = [];
  for (let index = 0; index < requests; index += 1) {
    const started = monotonicNow();
    try {
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      succeeded += 1;
      latencies.push(Math.max(0, monotonicNow() - started));
    } catch (error) {
      failed += 1;
      if (isTcpConnectError(error)) tcpConnectErrors += 1;
    }
  }
  latencies.sort((left, right) => left - right);
  const rounded = (value: number) => Math.round(value * 1000) / 1000;
  return {
    schemaVersion: 1,
    kind: "qwen-agent-worker-stability",
    baseUrl,
    model,
    startedAt,
    completedAt: new Date(now()).toISOString(),
    bootEpoch: health.bootEpoch,
    configRevision: health.configRevision,
    requested: requests,
    succeeded,
    failed,
    tcpConnectErrors,
    latencyMs: latencies.length === 0 ? null : {
      min: rounded(latencies[0]!),
      p50: rounded(percentile(latencies, 0.50)),
      p95: rounded(percentile(latencies, 0.95)),
      p99: rounded(percentile(latencies, 0.99)),
      max: rounded(latencies.at(-1)!),
    },
  };
}

if (import.meta.main) {
  try {
    const result = await runQwenAgentWorkerStability({
      baseUrl: process.env.LARM_BASE_URL ?? "http://192.168.0.130:9810",
      token: process.env.LARM_TOKEN ?? "",
      model: process.env.LARM_HTTP_MODEL ?? "qwen-agent-worker",
      requests: Number(process.env.LARM_STABILITY_REQUESTS ?? 100),
      timeoutMs: Number(process.env.LARM_HTTP_SMOKE_TIMEOUT_MS ?? 300_000),
    });
    console.log(JSON.stringify(result));
    if (result.failed > 0 || result.tcpConnectErrors > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`qwen-agent-worker stability verification failed: ${error instanceof Error ? error.message : "unknown_error"}`);
    process.exitCode = 1;
  }
}
