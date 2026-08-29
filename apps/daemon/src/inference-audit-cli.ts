import { LocalInferenceAuditStore } from "@larm/backends";
import type { ParsedInferenceAuditRecord } from "@larm/core";
import { parseInferenceAuditConfig } from "./config";
import { loadInferenceAuditKey } from "./inference-audit";

const USAGE = `usage:
  bun run inference:audit -- list
  bun run inference:audit -- show <request-id> [metadata|request|prompt|tokens|response|all]
  bun run inference:audit -- verify [request-id]
  bun run inference:audit -- prune`;

function printablePayload(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString("base64") };
  }
}

function summarize(record: ParsedInferenceAuditRecord) {
  return {
    requestId: record.requestId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    status: record.status,
    outcome: record.outcome,
    runtime: record.runtime,
    runtimeRelease: record.runtimeRelease,
    promptTokens: record.promptTokens,
    requestBytes: record.requestBytes,
    responseBytes: record.responseBytes,
    responseTruncated: record.responseTruncated,
  };
}

const config = parseInferenceAuditConfig();
const key = await loadInferenceAuditKey(config.inferenceAuditKeyFile);
const store = new LocalInferenceAuditStore({
  root: config.inferenceAuditRoot,
  key,
  retentionMs: config.inferenceAuditRetentionMs,
  maxBytes: config.inferenceAuditMaxBytes,
  minFreeBytes: config.inferenceAuditMinFreeBytes,
  maxResponseBytes: config.inferenceAuditMaxResponseBytes,
});
key.fill(0);
await store.initialize();

const [command, requestId, payload = "metadata", ...extra] = Bun.argv.slice(2);
if (extra.length > 0 || !command) {
  console.error(USAGE);
  process.exitCode = 2;
} else if (command === "list" && requestId === undefined) {
  console.log(JSON.stringify((await store.list()).map(summarize), null, 2));
} else if (command === "show" && requestId) {
  if (!["metadata", "request", "prompt", "tokens", "response", "all"].includes(payload)) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const record = await store.get(requestId);
    if (payload === "metadata") {
      console.log(JSON.stringify(record, null, 2));
    } else {
      const kinds = payload === "all"
        ? (["request", "prompt", "tokens", "response"] as const)
        : [payload as "request" | "prompt" | "tokens" | "response"];
      const output: Record<string, unknown> = { metadata: record };
      for (const kind of kinds) {
        if (record.payloads[kind]) {
          output[kind] = printablePayload(await store.readPayload(record, kind));
        }
      }
      console.log(JSON.stringify(output, null, 2));
    }
  }
} else if (command === "verify" && payload === "metadata") {
  const records = requestId ? [await store.get(requestId)] : await store.list();
  let payloads = 0;
  for (const record of records) {
    for (const kind of ["request", "prompt", "tokens", "response"] as const) {
      if (!record.payloads[kind]) continue;
      await store.readPayload(record, kind);
      payloads += 1;
    }
  }
  console.log(JSON.stringify({ ok: true, records: records.length, payloads }, null, 2));
} else if (command === "prune" && requestId === undefined) {
  console.log(JSON.stringify(await store.prune(), null, 2));
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
