import { createHash, timingSafeEqual } from "node:crypto";

export const SERVICE_HARNESS_ASR_RUNTIME = "qwen-asr";
export const SERVICE_HARNESS_ASR_MODEL = "qwen3-asr-1.7b";
export const SERVICE_HARNESS_ALLOCATION_ID = "alloc_service_harness";

export function secretMatches(actual: string | undefined, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return actual !== undefined && timingSafeEqual(actualDigest, expectedDigest);
}

export function isPersonalStateApiPath(path: string): boolean {
  return /^(?:\/v1\/(?:personal-state\/capability|context-sources|context-source-operations\/[^/]+|context-measurements(?:\/[^/]+)?|generation-attempts\/[^/]+(?:\/cancel)?|context-forget-operations(?:\/[^/]+)?)|\/v2\/context-views(?:\/[^/]+)?)$/.test(path);
}

export function acceptsProviderBearer(method: string, path: string): boolean {
  if (
    method === "POST"
    && new Set([
      "/v1/chat/completions",
      "/v1/audio/transcriptions",
      "/v1/audio/speech",
      "/v1/embed",
      "/v1/systemone",
    ]).has(path)
  ) return true;
  if (isPersonalStateApiPath(path)) {
    return method === "GET" || method === "POST";
  }
  if (method === "POST" && path === "/v1/contexts") return true;
  return method === "GET"
    && /^\/v1\/agent-connections\/[^/]+\/providers\/[^/]+\/health$/.test(path);
}

export function acceptsAnonymousAgentApi(method: string, path: string): boolean {
  if (method === "GET" && path === "/v1/activity") return true;
  if (
    method === "GET"
    && (path === "/v1/agent-profiles" || path === "/v2/agent-profiles" || path === "/v3/agent-profiles")
  ) return true;
  if (method === "POST" && path === "/v1/agent-connections") return true;
  if (/^\/v1\/agent-connections\/[^/]+$/.test(path)) {
    return method === "GET" || method === "DELETE";
  }
  if (/^\/v1\/agent-connections\/[^/]+\/health$/.test(path)) return method === "GET";
  return method === "POST"
    && /^\/v1\/agent-connections\/[^/]+\/(claim|renew)$/.test(path);
}

export function isServiceHarnessRequest(
  method: string,
  path: string,
  allocationId: string | undefined,
): boolean {
  return (method === "GET" && (path === "/v1/services" || path === "/v1/services/asr/health"))
    || (method === "POST" && path === "/v1/audio/transcriptions" && allocationId === undefined);
}
