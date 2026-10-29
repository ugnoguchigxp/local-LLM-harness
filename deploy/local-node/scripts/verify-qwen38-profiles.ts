import { verifyLfmInputCache } from "./verify-lfm-input-cache";

/** Use the same scoped-cache and four-request conformance gates as LFM3. */
export async function verifyQwen38Profile(variant: "fast", evidenceDir: string) {
  // Four cold 27B prefills exceed the smaller LFM fixture's time budget.
  const result = await verifyLfmInputCache(`qwen3.8-${variant}`, evidenceDir, 240_000);
  const props = result.props as { context?: number; slots?: number };
  if (props.context !== 200000 || props.slots !== 4 || result.peakConcurrentForwards !== 4) {
    throw new Error("Qwen retention profile must expose four independent 200k slots");
  }
  if (!(result.props as any).cache?.mtp_boundary_state || !result.mtpRestoration) {
    throw new Error("Qwen must retain the MTP boundary and accept drafts after RAM restoration");
  }
  return result;
}

if (import.meta.main) {
  const variant = process.argv[2];
  if (variant !== "fast") throw new Error("usage: verify-qwen38-profiles.ts fast EVIDENCE_DIR");
  if (!process.argv[3]?.startsWith("/")) throw new Error("absolute evidence directory is required");
  console.log(JSON.stringify(await verifyQwen38Profile(variant, process.argv[3]), null, 2));
}
