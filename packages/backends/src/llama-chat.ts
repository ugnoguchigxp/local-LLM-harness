import { reasoningEffortSchema, type RuntimeDefinition } from "@larm/core";

export class LlamaChatRequestError extends Error {
  readonly status = 400;
  readonly code = "invalid_request";
}

/** Adapt after runtime resolution so aliases and scoped credentials use the same policy. */
export function prepareLlamaChatRequest(bytes: Uint8Array, runtime: RuntimeDefinition): Uint8Array {
  if (runtime.backend !== "llama-swap" || runtime.deployment.chatAdapter !== "llama-reasoning-budget-v1") return bytes;
  if (!runtime.reasoning) throw new Error("reasoning adapter requires a runtime policy");
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  for (const field of ["thinking_budget_tokens", "thinking_token_budget", "reasoning_budget_tokens", "reasoning_budget_message",
    "reasoning_budget_start_tag", "reasoning_budget_end_tag", "reasoning_budget_end_tags", "reasoning_control"]) {
    if (body[field] !== undefined) throw new LlamaChatRequestError("use reasoning_effort to configure reasoning");
  }
  // llama.cpp gives n_predict precedence over max_tokens, and reasoning_format can
  // place internal thinking in content instead of reasoning_content.
  for (const field of ["n_predict", "reasoning_format"]) {
    if (body[field] !== undefined) throw new LlamaChatRequestError(`${field} is not supported by this provider`);
  }
  const effort = reasoningEffortSchema.safeParse(body.reasoning_effort ?? runtime.reasoning.defaultEffort);
  if (!effort.success) throw new LlamaChatRequestError("this provider supports reasoning_effort low, medium, high, or max");
  const kwargs = body.chat_template_kwargs;
  if (kwargs !== undefined && (!kwargs || typeof kwargs !== "object" || Array.isArray(kwargs))) {
    throw new LlamaChatRequestError("chat_template_kwargs must be an object");
  }
  const template = (kwargs ?? {}) as Record<string, unknown>;
  if (template.enable_thinking !== undefined && template.enable_thinking !== true) {
    throw new LlamaChatRequestError("this provider requires reasoning; use reasoning_effort to select its effort");
  }
  body.chat_template_kwargs = { ...template, enable_thinking: true };
  // This adapter targets the pinned official llama.cpp engine, which reads reasoning_budget_tokens.
  body.reasoning_budget_tokens = runtime.reasoning.budgets[effort.data];
  // The backend implements effort through its budget, not the effort label in its template.
  delete body.reasoning_effort;
  if (body.tool_choice === undefined && (!Array.isArray(body.tools) || body.tools.length === 0)
    && body.response_format && typeof body.response_format === "object"
    && (body.response_format as Record<string, unknown>).type === "json_schema") {
    body.tool_choice = "none";
  }
  return new TextEncoder().encode(JSON.stringify(body));
}
