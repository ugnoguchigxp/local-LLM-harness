import { z } from "zod";
import type { NodeAdmission } from "./admission";

export const nodeAdmissionSchema = z.object({
  node: z.string().min(1),
  usableMemoryGB: z.number(),
  committedMemoryGB: z.number(),
  incrementalMemoryGB: z.number(),
  availableMemoryGB: z.number(),
  liveAvailableMemoryGB: z.number().optional(),
  effectiveLiveAvailableMemoryGB: z.number().optional(),
  reclaimableMemoryGB: z.number().optional(),
}).strict();

// Optional additions keep persisted errors and older daemon responses readable.
export const resourceErrorFields = {
  type: z.string().min(1).max(128).optional(),
  resource: z.literal("memory").optional(),
  reason: z.enum(["memory_exhausted", "live_memory_exhausted"]).optional(),
  retry: z.literal("after_capacity_change").optional(),
  admission: z.array(nodeAdmissionSchema).optional(),
};

/** Only explicit admission evidence is classified as memory pressure. */
export function memoryResourceError(reason: string, message: string, admission?: readonly NodeAdmission[]) {
  if (reason !== "memory_exhausted" && reason !== "live_memory_exhausted") return undefined;
  return {
    code: "resource_exhausted" as const,
    message,
    type: "resource_error" as const,
    resource: "memory" as const,
    reason,
    retry: "after_capacity_change" as const,
    ...(admission ? { admission: [...admission] } : {}),
  } as const;
}
