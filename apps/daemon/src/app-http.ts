import { providerStartupPolicy, type Allocation, type AllocationRequest, type ClusterState, type Registry } from "@larm/core";
import { createHash } from "node:crypto";
import { readBodyLimited, RequestBodyError } from "./http-body";

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function openAiErrorBody(code: string, message: string, param: string | null = null) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code,
    },
  };
}

export function publicRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    protocol: runtime.protocol,
    policy: { class: runtime.policy.class },
    startupPolicy: providerStartupPolicy(runtime),
  };
}

export function publicClusterState(state: ClusterState) {
  return {
    generatedAt: state.generatedAt,
    online: state.node.online,
    runtimes: state.runtimes.map((runtime) => ({
      id: runtime.id,
      status: runtime.status,
      class: runtime.class,
      capability: runtime.capability,
      observedAt: runtime.observedAt,
      ...(runtime.health ? { health: { ok: runtime.health.ok } } : {}),
    })),
  };
}

export function inspectionRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    protocol: runtime.protocol,
    ...(runtime.embedding ? { embedding: runtime.embedding } : {}),
    backend: runtime.backend,
    node: runtime.node,
    policy: runtime.policy,
    resources: runtime.resources,
    deployment: runtime.deployment,
  };
}

export function publicAllocation(allocation: Allocation) {
  return {
    ...allocation,
    bindings: allocation.bindings.map(({
      endpoint: _endpoint,
      providerRevision: _providerRevision,
      instanceId: _instanceId,
      instanceGeneration: _instanceGeneration,
      ...binding
    }) => binding),
  };
}

export async function readJson(c: { req: { raw: Request } }, maxBytes: number): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBodyLimited(c.req.raw, maxBytes);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      throw err;
    }
    throw new RequestBodyError("bad_request", "request body could not be read", 400);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestBodyError("bad_request", "request body must be valid UTF-8 JSON", 400);
  }
}

export function normalizedAllocationRequestHash(request: AllocationRequest): string {
  const normalized = {
    ...request,
    requirements: [...request.requirements].sort((left, right) => {
      const leftKey = `${left.capability}\0${left.route}`;
      const rightKey = `${right.capability}\0${right.route}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function normalizeQwen38ChatRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestBodyError("invalid_request", "chat request must be a JSON object", 400);
  }
  const request = structuredClone(value as Record<string, unknown>);
  if (request.model !== "qwen3.8") return request;

  const template = request.chat_template_kwargs;
  if (request.reasoning_effort === undefined) {
    if (template === undefined) {
      request.chat_template_kwargs = { enable_thinking: false };
    } else if (template && typeof template === "object" && !Array.isArray(template)) {
      const kwargs = template as Record<string, unknown>;
      if (kwargs.enable_thinking === undefined) kwargs.enable_thinking = false;
    }
  }

  const messages = Array.isArray(request.messages) ? request.messages : [];
  const messageCharacters = messages.reduce((sum, message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return sum;
    const content = (message as Record<string, unknown>).content;
    return sum + (typeof content === "string" ? content.length : 0);
  }, 0);
  const lastMessage = messages.at(-1);
  const lastContent = lastMessage && typeof lastMessage === "object" && !Array.isArray(lastMessage)
    ? (lastMessage as Record<string, unknown>).content
    : undefined;
  const exactLiteral = typeof lastContent === "string"
    ? /^Reply with just ([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.\s*$/.exec(lastContent)?.[1]
    : undefined;
  if (
    exactLiteral
    && request.grammar === undefined
    && request.response_format === undefined
    && request.tools === undefined
  ) {
    request.grammar = `root ::= "${exactLiteral}"`;
  }
  if ((exactLiteral || messageCharacters >= 1_000_000) && request["speculative.n_max"] === undefined) {
    request["speculative.n_max"] = 0;
  }

  const choice = request.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return request;
  const functionChoice = (choice as Record<string, unknown>).function;
  const name = functionChoice && typeof functionChoice === "object" && !Array.isArray(functionChoice)
    ? (functionChoice as Record<string, unknown>).name
    : undefined;
  const tools = request.tools;
  if (typeof name !== "string" || !Array.isArray(tools)) {
    throw new RequestBodyError("invalid_tool_choice", "named tool_choice must reference a declared function", 400);
  }
  const selected = tools.find((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = (tool as Record<string, unknown>).function;
    return fn && typeof fn === "object" && !Array.isArray(fn)
      && (fn as Record<string, unknown>).name === name;
  });
  if (!selected) {
    throw new RequestBodyError("invalid_tool_choice", `tool_choice function ${name} is not declared`, 400);
  }
  request.tools = [selected];
  request.tool_choice = "required";
  if (request["speculative.n_max"] === undefined) request["speculative.n_max"] = 0;
  return request;
}
