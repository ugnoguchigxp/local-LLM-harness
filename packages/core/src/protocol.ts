import type { Allocation, AllocationBinding } from "./allocation";
import type { Registry } from "./registry";
import type { RuntimeProtocol } from "./schema";

export type BindingSelection =
  | { ok: true; binding: AllocationBinding }
  | {
      ok: false;
      reason: "capability_not_allocated" | "protocol_not_allocated" | "protocol_mismatch" | "ambiguous_binding";
    };

export function selectProtocolBinding(input: {
  registry: Registry;
  allocation: Allocation;
  protocol: RuntimeProtocol;
  capability?: string;
}): BindingSelection {
  const runtimeById = new Map(input.registry.runtimes.map((runtime) => [runtime.id, runtime]));
  if (input.capability) {
    const binding = input.allocation.bindings.find(
      (candidate) => candidate.capability === input.capability,
    );
    if (!binding) {
      return { ok: false, reason: "capability_not_allocated" };
    }
    if (runtimeById.get(binding.runtime)?.protocol !== input.protocol) {
      return { ok: false, reason: "protocol_mismatch" };
    }
    return { ok: true, binding };
  }

  const compatible = input.allocation.bindings.filter(
    (binding) => runtimeById.get(binding.runtime)?.protocol === input.protocol,
  );
  if (compatible.length === 0) {
    return { ok: false, reason: "protocol_not_allocated" };
  }
  if (input.protocol === "openai.chat-completions.v1") {
    const general = compatible.find((binding) => binding.capability === "llm.general");
    if (general) {
      return { ok: true, binding: general };
    }
  }
  if (compatible.length !== 1) {
    return { ok: false, reason: "ambiguous_binding" };
  }
  return { ok: true, binding: compatible[0]! };
}
