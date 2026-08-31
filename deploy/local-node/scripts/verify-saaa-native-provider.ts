import {
  NATIVE_LLM_STREAM_PROTOCOL,
  NativeWebSocketLlmStreamBackend,
} from "../../../packages/backends/src/index";

const url = process.env.LARM_NATIVE_STREAM_URL
  ?? "ws://127.0.0.1:8090/v1/native/llm/stream";
const timeoutMs = Number(process.env.LARM_NATIVE_STREAM_CONNECT_TIMEOUT_MS ?? "5000");
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
  throw new Error("LARM_NATIVE_STREAM_CONNECT_TIMEOUT_MS must be an integer in 100..30000");
}
const requiredConcurrentRuns = Number(process.env.LARM_NATIVE_STREAM_REQUIRED_CONCURRENCY ?? "1");
if (!Number.isInteger(requiredConcurrentRuns) || requiredConcurrentRuns < 1 || requiredConcurrentRuns > 8) {
  throw new Error("LARM_NATIVE_STREAM_REQUIRED_CONCURRENCY must be an integer in 1..8");
}

const backend = new NativeWebSocketLlmStreamBackend("qwen-general", {
  url,
  protocol: NATIVE_LLM_STREAM_PROTOCOL,
  connectTimeoutMs: timeoutMs,
  requiredConcurrentRuns,
});
const ready = await backend.ready();
console.log(JSON.stringify({
  runtime: backend.runtimeId,
  protocol: NATIVE_LLM_STREAM_PROTOCOL,
  requiredConcurrentRuns,
  ready,
}));
if (!ready) process.exitCode = 1;
