import { z } from "zod";
import type { RuntimeDefinition } from "./schema";
import { isLiteralLoopbackHost } from "./network";

const variantSchema = z.object({
  healthUrl: z.string().url(),
  idleTtlSeconds: z.literal(0),
  estimatedMemoryGB: z.number().positive(),
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/),
  models: z.array(z.enum(["qwen-image-2.1-turbo", "flux-3-image-klein"])).optional(),
});

/** Demand-only media workers must stop after each request. */
export const mediaPolicySchema = z.object({
  groups: z.object({ "accelerator-media-heavy": z.object({ minimumAvailableMemoryGB: z.number().nonnegative() }) }),
  variants: z.object({ image: variantSchema, "image-flux3": variantSchema.optional(), music: variantSchema, mesh: variantSchema.optional(), "stable-audio": variantSchema }),
});


/** A media health response must never masquerade as another local Provider. */
export function validateMediaPolicyPorts(policy: z.infer<typeof mediaPolicySchema>, runtimes: readonly RuntimeDefinition[], nodeId: string): void {
  const ports = new Map<number, string>();
  for (const runtime of runtimes) if (runtime.node === nodeId && runtime.backend === "systemd") {
    ports.set(runtime.deployment.healthPort, runtime.deployment.service);
  }
  for (const [variant, worker] of Object.entries(policy.variants)) {
    if (!worker) continue;
    const url = new URL(worker.healthUrl);
    if (url.hostname !== "localhost" && !isLiteralLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""))) continue;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const owner = ports.get(port);
    if (owner && owner !== worker.service) throw new Error(`media variant ${variant} health port ${port} conflicts with ${owner}`);
    ports.set(port, worker.service);
  }
}
