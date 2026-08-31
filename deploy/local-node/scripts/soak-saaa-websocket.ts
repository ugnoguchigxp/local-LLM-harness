import { createHash, randomUUID } from "node:crypto";
import { LarmClient } from "../../../packages/client/src/index";
import {
  decodeSaaaDelta,
  isLiteralLoopbackHost,
  parseSaaaServerControl,
  SAAA_LLM_STREAM_PROTOCOL,
  type AgentConnectionClaim,
} from "../../../packages/core/src/index";
import type { SmokeConfig } from "./smoke-saaa-websocket";

const REQUIRED_TURNS = 1_000;
const REQUIRED_DURATION_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_RSS_GROWTH_BYTES = 64 * 1024 * 1024;
type Environment = Record<string, string | undefined>;
type SoakLifecycleClient = Pick<LarmClient, "renewAgentConnection" | "claimAgentConnection">;
type SoakClientFactory = (options: {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
}) => SoakLifecycleClient;

type SoakConfig = SmokeConfig & {
  turns: number;
  minimumDurationMs: number;
  maxRssGrowthBytes: number;
  rotateCredential: () => Promise<string>;
};

type FlapTurnResult = {
  contentBytes: number;
  uniqueDeltas: number;
  replayedDeltas: number;
  firstDeltaMs: number;
  durationMs: number;
  nextToken: string;
};

function integerSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: Environment,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function required(name: string, env: Environment): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function providerFromClaim(claim: AgentConnectionClaim, providerName: string) {
  const provider = claim.providers.find((candidate) => candidate.name === providerName);
  if (!provider || provider.protocol !== "openai.chat-completions.v1" || !provider.streaming) {
    throw new Error(`claim provider ${providerName} does not advertise native SAAA streaming`);
  }
  return provider;
}

function stableClaimInvariant(claim: AgentConnectionClaim, providerName: string): string {
  const provider = providerFromClaim(claim, providerName);
  return JSON.stringify({
    id: claim.id,
    allocationId: claim.allocationId,
    audience: claim.audience,
    provider: {
      name: provider.name,
      capability: provider.capability,
      apiStyle: provider.apiStyle,
      protocol: provider.protocol,
      scheme: provider.scheme,
      host: provider.host,
      port: provider.port,
      baseUrl: provider.baseUrl,
      model: provider.model,
      health: provider.health,
      credentialType: provider.credential.type,
      configuration: provider.configuration,
      streaming: provider.streaming,
    },
  });
}

export async function loadSoakConfig(
  env: Environment = process.env,
  createClient: SoakClientFactory = (options) => new LarmClient(options),
): Promise<SoakConfig> {
  const baseUrl = new URL(required("LARM_BASE_URL", env));
  const hostname = baseUrl.hostname.replace(/^\[|\]$/g, "");
  if (
    baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
    || (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
    || (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && isLiteralLoopbackHost(hostname)))
  ) {
    throw new Error("LARM_BASE_URL must be canonical HTTPS, or HTTP on literal loopback");
  }
  const connectionId = required("LARM_SAAA_CONNECTION_ID", env);
  if (!/^aconn_[A-Za-z0-9._-]{1,185}$/.test(connectionId)) {
    throw new Error("LARM_SAAA_CONNECTION_ID is invalid");
  }
  const providerName = env.LARM_SAAA_PROVIDER_NAME ?? "llm";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerName)) {
    throw new Error("LARM_SAAA_PROVIDER_NAME is invalid");
  }
  const timeoutMs = integerSetting("LARM_SAAA_SMOKE_TIMEOUT_MS", 30_000, 1_000, 300_000, env);
  const renewTtlSeconds = integerSetting("LARM_SAAA_SOAK_RENEW_TTL_SECONDS", 3_600, 300, 86_400, env);
  const client = createClient({
    baseUrl: baseUrl.toString(),
    apiToken: required("LARM_API_TOKEN", env),
    timeoutMs,
  });
  await client.renewAgentConnection(connectionId, renewTtlSeconds);
  const initialClaim = await client.claimAgentConnection(connectionId);
  const initialProvider = providerFromClaim(initialClaim, providerName);
  const claimInvariant = stableClaimInvariant(initialClaim, providerName);
  const invariant = {
    claimId: initialClaim.id,
    allocationId: initialClaim.allocationId,
    model: initialProvider.model,
    streamUrl: initialProvider.streaming!.url,
  };
  let previousToken = initialProvider.credential.token;

  return {
    url: invariant.streamUrl,
    token: previousToken,
    allocationId: invariant.allocationId,
    model: invariant.model,
    timeoutMs,
    turns: integerSetting("LARM_SAAA_SOAK_TURNS", REQUIRED_TURNS, REQUIRED_TURNS, 10_000, env),
    minimumDurationMs: integerSetting(
      "LARM_SAAA_SOAK_DURATION_MS",
      REQUIRED_DURATION_MS,
      REQUIRED_DURATION_MS,
      24 * 60 * 60 * 1_000,
      env,
    ),
    maxRssGrowthBytes: integerSetting(
      "LARM_SAAA_SOAK_MAX_RSS_GROWTH_BYTES",
      DEFAULT_MAX_RSS_GROWTH_BYTES,
      1,
      DEFAULT_MAX_RSS_GROWTH_BYTES,
      env,
    ),
    rotateCredential: async () => {
      await client.renewAgentConnection(connectionId, renewTtlSeconds);
      const claim = await client.claimAgentConnection(connectionId);
      const provider = providerFromClaim(claim, providerName);
      if (stableClaimInvariant(claim, providerName) !== claimInvariant) {
        throw new Error("renewed SAAA claim changed a connection or Provider invariant");
      }
      const nextToken = provider.credential.token;
      if (nextToken === previousToken) throw new Error("Agent Connection renewal did not rotate the Provider token");
      previousToken = nextToken;
      return nextToken;
    },
  };
}

export async function runSaaaWebSocketSoak(config: SoakConfig): Promise<{
  protocol: typeof SAAA_LLM_STREAM_PROTOCOL;
  outcome: "passed";
  turns: number;
  networkFlaps: number;
  uniqueDeltas: number;
  replayedDeltas: number;
  contentBytes: number;
  credentialRotated: boolean;
  durationMs: number;
  latencyMs: {
    firstDelta: { p50: number; p95: number; p99: number };
    turn: { p50: number; p95: number; p99: number };
  };
  memory: {
    peakRssGrowthBytes: number;
    settledRssGrowthBytes: number;
  };
}> {
  const startedAt = performance.now();
  const initialRss = process.memoryUsage.rss();
  let peakRss = initialRss;
  let uniqueDeltas = 0;
  let replayedDeltas = 0;
  let contentBytes = 0;
  const firstDeltaSamples: number[] = [];
  const turnSamples: number[] = [];
  let currentToken = config.token;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 100);
  memorySampler.unref?.();

  try {
    for (let index = 0; index < config.turns; index += 1) {
      if (index > 0) {
        const scheduledAt = startedAt + (config.minimumDurationMs * index) / (config.turns - 1);
        const waitMs = scheduledAt - performance.now();
        if (waitMs > 0) await Bun.sleep(waitMs);
      }
      config.token = currentToken;
      const result = await runFlapTurn(config);
      if (result.nextToken === currentToken) {
        throw new Error("SAAA WebSocket soak resumed without credential rotation");
      }
      currentToken = result.nextToken;
      uniqueDeltas += result.uniqueDeltas;
      replayedDeltas += result.replayedDeltas;
      contentBytes += result.contentBytes;
      firstDeltaSamples.push(result.firstDeltaMs);
      turnSamples.push(result.durationMs);
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
      if (peakRss - initialRss > config.maxRssGrowthBytes) {
        throw new Error("SAAA WebSocket soak exceeded the RSS growth limit");
      }
    }
  } finally {
    clearInterval(memorySampler);
  }

  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs < config.minimumDurationMs || replayedDeltas < config.turns) {
    throw new Error("SAAA WebSocket soak did not satisfy its duration or replay gate");
  }
  Bun.gc(true);
  const settledRss = process.memoryUsage.rss();
  peakRss = Math.max(peakRss, settledRss);
  const settledRssGrowthBytes = Math.max(0, settledRss - initialRss);
  if (settledRssGrowthBytes > config.maxRssGrowthBytes) {
    throw new Error("SAAA WebSocket soak exceeded the settled RSS growth limit");
  }
  return {
    protocol: SAAA_LLM_STREAM_PROTOCOL,
    outcome: "passed",
    turns: config.turns,
    networkFlaps: config.turns,
    uniqueDeltas,
    replayedDeltas,
    contentBytes,
    credentialRotated: true,
    durationMs,
    latencyMs: {
      firstDelta: summarizeLatency(firstDeltaSamples),
      turn: summarizeLatency(turnSamples),
    },
    memory: {
      peakRssGrowthBytes: Math.max(0, peakRss - initialRss),
      settledRssGrowthBytes,
    },
  };
}

async function runFlapTurn(config: SoakConfig): Promise<FlapTurnResult> {
  const startedAt = performance.now();
  const runId = `run_soak_${randomUUID()}`;
  const hash = createHash("sha256");
  const emptyHash = hash.copy().digest("hex");
  let appliedSeq = 1;
  let contentBytes = 0;
  let uniqueDeltas = 0;
  let replayedDeltas = 0;
  let firstDeltaDigest: string | undefined;
  let firstDeltaBytes = 0;
  let firstDeltaAt: number | undefined;
  let activeSocket: WebSocket | undefined;
  let reconnectAfterClose: WebSocket | undefined;
  let resumeToken: string | undefined;
  let runAccepted = false;
  const readySockets = new WeakSet<WebSocket>();
  const readyTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("SAAA WebSocket flap turn timed out")), config.timeoutMs);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const readyTimer of readyTimers.values()) clearTimeout(readyTimer);
      readyTimers.clear();
      activeSocket?.close(1000, "soak failed");
      reject(error instanceof Error ? error : new Error("SAAA WebSocket flap turn failed"));
    };
    const connect = (resume: boolean) => {
      if (settled) return;
      let awaitingResume = resume;
      let serial = Promise.resolve();
      const credential = resume ? resumeToken : config.token;
      if (!credential) throw new Error("rotated Provider credential is unavailable");
      const socket = new WebSocket(config.url, {
        protocols: [SAAA_LLM_STREAM_PROTOCOL],
        headers: { Authorization: `Bearer ${credential}` },
        perMessageDeflate: false,
      });
      socket.binaryType = "arraybuffer";
      activeSocket = socket;
      socket.addEventListener("open", () => {
        if (socket.protocol !== SAAA_LLM_STREAM_PROTOCOL || socket.extensions !== "") {
          fail(new Error("SAAA WebSocket transport negotiation is non-conformant"));
          return;
        }
        if (!readySockets.has(socket)) {
          readyTimers.set(socket, setTimeout(() => {
            fail(new Error("connection.ready exceeded five seconds during soak"));
          }, 5_000));
        }
      }, { once: true });
      socket.addEventListener("error", () => {
        if (socket !== reconnectAfterClose) fail(new Error("SAAA WebSocket transport failed"));
      }, { once: true });
      socket.addEventListener("close", () => {
        const readyTimer = readyTimers.get(socket);
        if (readyTimer) clearTimeout(readyTimer);
        readyTimers.delete(socket);
        if (settled) return;
        if (socket !== reconnectAfterClose) {
          fail(new Error("SAAA WebSocket closed outside the planned flap"));
          return;
        }
        reconnectAfterClose = undefined;
        void config.rotateCredential().then((token) => {
          if (settled) return;
          if (token === config.token) throw new Error("Provider credential did not rotate during the network flap");
          resumeToken = token;
          connect(true);
        }).catch(fail);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        serial = serial.then(async () => {
          awaitingResume = await handleMessage(socket, awaitingResume, event.data);
        }).catch(fail);
      });
    };
    const handleMessage = async (
      socket: WebSocket,
      awaitingResume: boolean,
      data: string | ArrayBuffer | Blob,
    ): Promise<boolean> => {
      if (socket !== activeSocket || settled) return awaitingResume;
      if (typeof data !== "string") {
        if (!runAccepted || awaitingResume) {
          throw new Error("SAAA delta arrived before run acceptance or resume confirmation");
        }
        const frame = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Blob
            ? new Uint8Array(await data.arrayBuffer())
            : undefined;
        if (!frame) throw new Error("unsupported SAAA WebSocket binary representation");
        const delta = decodeSaaaDelta(frame);
        const seq = Number(delta.seq);
        if (seq === appliedSeq) {
          const digest = createHash("sha256").update(delta.payload).digest("hex");
          if (seq !== 2 || digest !== firstDeltaDigest || delta.payload.byteLength !== firstDeltaBytes) {
            throw new Error("replayed delta differs from the pre-flap event");
          }
          replayedDeltas += 1;
        } else {
          if (seq !== appliedSeq + 1) throw new Error("SAAA delta sequence is non-contiguous");
          appliedSeq = seq;
          hash.update(delta.payload);
          contentBytes += delta.payload.byteLength;
          uniqueDeltas += 1;
          if (seq === 2 && firstDeltaDigest === undefined) {
            firstDeltaAt = performance.now();
            firstDeltaDigest = createHash("sha256").update(delta.payload).digest("hex");
            firstDeltaBytes = delta.payload.byteLength;
            reconnectAfterClose = socket;
            activeSocket = undefined;
            socket.close(1001, "planned soak flap");
            return awaitingResume;
          }
        }
        socket.send(JSON.stringify({
          type: "run.ack",
          runId,
          ackSeq: appliedSeq,
          contentSha256: hash.copy().digest("hex"),
        }));
        return awaitingResume;
      }
      const message = parseSaaaServerControl(data);
      if (message.type === "connection.ready") {
        if (readySockets.has(socket)) throw new Error("duplicate connection.ready during soak");
        readySockets.add(socket);
        const readyTimer = readyTimers.get(socket);
        if (readyTimer) clearTimeout(readyTimer);
        readyTimers.delete(socket);
        socket.send(JSON.stringify(awaitingResume
          ? {
              type: "run.resume",
              runId,
              allocationId: config.allocationId,
              ackSeq: 1,
              contentSha256: emptyHash,
            }
          : {
              type: "run.start",
              runId,
              allocationId: config.allocationId,
              model: config.model,
              messages: [{ role: "user", content: config.prompt ?? "Reply with exactly: READY" }],
              maxOutputTokens: config.maxOutputTokens ?? 32,
              maxToolCalls: 0,
              timeoutMs: config.timeoutMs,
            }));
        return awaitingResume;
      }
      if (message.type === "run.accepted") {
        if (runAccepted || awaitingResume || message.runId !== runId || message.seq !== 1) {
          throw new Error("invalid run.accepted during soak");
        }
        runAccepted = true;
        socket.send(JSON.stringify({
          type: "run.ack",
          runId,
          ackSeq: 1,
          contentSha256: emptyHash,
        }));
        return awaitingResume;
      }
      if (message.type === "run.resumed") {
        if (!awaitingResume || message.runId !== runId || message.ackSeq !== 1) {
          throw new Error("invalid run.resumed during soak");
        }
        return false;
      }
      if (message.type === "response.completed") {
        if (
          awaitingResume
          || !runAccepted
          || firstDeltaDigest === undefined
          || replayedDeltas !== 1
          || message.runId !== runId
          || message.seq !== appliedSeq + 1
          || message.contentBytes !== contentBytes
          || message.contentSha256 !== hash.copy().digest("hex")
        ) throw new Error("terminal integrity failed during soak");
        socket.send(JSON.stringify({
          type: "run.ack",
          runId,
          ackSeq: message.seq,
          contentSha256: message.contentSha256,
        }));
        settled = true;
        clearTimeout(timer);
        for (const readyTimer of readyTimers.values()) clearTimeout(readyTimer);
        readyTimers.clear();
        socket.close(1000, "soak turn complete");
        if (firstDeltaAt === undefined) throw new Error("soak turn completed without a first delta");
        resolve({
          contentBytes,
          uniqueDeltas,
          replayedDeltas,
          firstDeltaMs: firstDeltaAt - startedAt,
          durationMs: performance.now() - startedAt,
          nextToken: resumeToken!,
        });
        return awaitingResume;
      }
      if (message.type === "response.failed") throw new Error(`soak run failed: ${message.error.code}`);
      throw new Error(`unexpected soak message ${message.type}`);
    };
    connect(false);
  });
}

function summarizeLatency(values: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

if (import.meta.main) {
  const config = await loadSoakConfig();
  try {
    console.log(JSON.stringify(await runSaaaWebSocketSoak(config)));
  } finally {
    config.token = "";
  }
}
