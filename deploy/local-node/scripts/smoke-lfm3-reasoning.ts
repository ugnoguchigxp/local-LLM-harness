/** Exercise the shared public reasoning canary against the explicit LFM3 model. */
import { runLfm25ReasoningSmoke } from "./smoke-lfm25-reasoning";

if (import.meta.main) {
  const apiToken = process.env.LARM_API_TOKEN;
  if (!apiToken) throw new Error("LARM_API_TOKEN is required");
  console.log(JSON.stringify(await runLfm25ReasoningSmoke({
    baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
    apiToken,
    model: "lfm3-1.7b",
  }), null, 2));
}
