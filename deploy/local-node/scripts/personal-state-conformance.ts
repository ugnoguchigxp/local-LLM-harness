import { createHash, randomUUID } from "node:crypto";
import { LarmClient } from "../../../packages/client/src/index";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const baseUrl = process.env.LARM_BASE_URL?.trim() || "http://127.0.0.1:9810";
const providerToken = required("LARM_PERSONAL_STATE_PROVIDER_TOKEN");
const allocationId = required("LARM_PERSONAL_STATE_ALLOCATION_ID");
const runtime = required("LARM_PERSONAL_STATE_RUNTIME");
const model = required("LARM_PERSONAL_STATE_MODEL");
const runId = randomUUID();
const incarnation = `ps-conformance-${runId}`;
const contextId = `ps-conformance-${runId}`;
const measurementId = `ps-measure-${runId}`;
const viewRequestId = `ps-view-request-${runId}`;
const attemptId = `ps-attempt-${runId}`;
const forgetId = `ps-forget-${runId}`;
const content = `Synthetic Personal State conformance source. nonce=${runId}`;
const sourceDigest = sha256(content);
const client = new LarmClient({ baseUrl, timeoutMs: 330_000 });
const options = { providerToken };
let sourceHandle: string | undefined;
let primaryError: unknown;

try {
  const capability = await client.getPersonalStateCapability(allocationId, runtime, options);
  const source = await client.provisionContextSource({
    incarnation,
    allocationId,
    runtime,
    sourceDigest,
    content,
  }, options);
  sourceHandle = source.sourceHandle;
  const replay = await client.provisionContextSource({
    incarnation,
    allocationId,
    runtime,
    sourceDigest,
    content,
  }, options);
  if (replay.sourceHandle !== source.sourceHandle) {
    throw new Error("source replay returned another handle");
  }
  const queriedSource = await client.getContextSourceOperation(incarnation, options);
  if (queriedSource.sourceDigest !== sourceDigest) throw new Error("source receipt digest drifted");

  await client.registerPersonalStateContext({
    id: contextId,
    version: "v1",
    sourceHandle: source.sourceHandle,
    sourceDigest,
    classification: "restricted",
    byteCount: source.byteCount,
    tokenCount: source.tokenCount,
    tokenizerDigest: source.tokenizerDigest,
  }, { ...options, idempotencyKey: `register-${runId}` });

  const request = {
    model,
    messages: [{ role: "user", content: "Acknowledge the synthetic context in one short sentence." }],
    tools: [{
      type: "function",
      function: {
        name: "synthetic_noop",
        description: "A synthetic conformance-only tool that must not be called.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }],
    tool_choice: "none",
    temperature: 0,
    max_tokens: 8,
    stream: false,
  };
  const certifiedInputBudget = capability.contextLimitTokens
    - capability.outputReserveTokens
    - capability.safetyMarginTokens;
  if (certifiedInputBudget < 1) throw new Error("certified input budget is empty");
  const measurement = await client.createContextMeasurement({
    measurementId,
    allocationId,
    runtime,
    maxInputTokens: certifiedInputBudget,
    request,
  }, options);
  const viewDeadline = new Date(Math.min(
    Date.parse(capability.leaseExpiresAt),
    Date.parse(capability.credentialExpiresAt),
    Date.now() + 2 * 60_000,
  )).toISOString();
  const view = await client.createPersonalStateView({
    viewRequestId,
    measurementId,
    allocationId,
    runtime,
    maxInputTokens: measurement.maxInputTokens,
    deadline: viewDeadline,
    canonicalizationVersion: "context-view-v2",
    request,
    items: [{ contextId, version: "v1", required: true, utility: 1 }],
  }, { ...options, idempotencyKey: `view-${runId}` });
  const durableView = await client.getPersonalStateViewReceipt(viewRequestId, options);
  if (durableView.viewId !== view.id || durableView.state !== "ready") {
    throw new Error("durable view receipt does not match the one-shot view");
  }

  const response = await client.chatPersonalState({
    allocationId,
    attemptId,
    viewId: view.id,
    body: request,
  }, options);
  const generationStatus = response.status;
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`Personal State generation returned HTTP ${generationStatus}`);

  let attempt = await client.getGenerationAttempt(attemptId, options);
  for (let iteration = 0; iteration < 100 && ![
    "completed", "failed", "cancelled", "result_unknown",
  ].includes(attempt.state); iteration += 1) {
    await Bun.sleep(100);
    attempt = await client.getGenerationAttempt(attemptId, options);
  }
  if (attempt.state !== "completed") {
    throw new Error(`generation attempt ended in ${attempt.state}/${attempt.stopState}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    const forgotten = await client.forgetPersonalState({
      forgetId,
      incarnation,
      contextIds: [contextId],
      sourceHandles: sourceHandle ? [sourceHandle] : [],
      attemptIds: [attemptId],
    }, options);
    if (forgotten.state !== "succeeded" || !forgotten.absenceVerified) {
      throw new Error(`forget ended in ${forgotten.state}`);
    }
    const receipt = await client.getForgetOperation(forgetId, options);
    if (receipt.state !== "succeeded" || !receipt.absenceVerified) {
      throw new Error("queried forget receipt does not prove absence");
    }
  } catch (cleanupError) {
    throw new AggregateError(
      primaryError ? [primaryError, cleanupError] : [cleanupError],
      "Personal State conformance cleanup did not prove absence",
    );
  }
}

if (primaryError) throw primaryError;
process.stdout.write(`${JSON.stringify({
  contractVersion: "larm-personal-state.v1",
  result: "passed",
  runId,
  incarnation,
  contextId,
  measurementId,
  viewRequestId,
  attemptId,
  forgetId,
  sourceDigest,
}, null, 2)}\n`);
