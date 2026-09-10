import { createHash } from "node:crypto";

const corpus = [
  "hello",
  "日本語の文脈テスト",
  "line one\nline two",
  "<|im_start|>system",
  "emoji 🧠 context",
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function identity(endpoint: string) {
  const base = endpoint.replace(/\/$/, "");
  const propsResponse = await fetch(`${base}/props`);
  if (!propsResponse.ok) throw new Error(`${base}/props returned ${propsResponse.status}`);
  const props = await propsResponse.json() as Record<string, unknown>;
  if (typeof props.chat_template !== "string") throw new Error(`${base}/props has no chat_template`);
  const results: unknown[] = [];
  for (const content of corpus) {
    const response = await fetch(`${base}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, add_special: false, with_pieces: true }),
    });
    if (!response.ok) throw new Error(`${base}/tokenize returned ${response.status}`);
    results.push(await response.json());
  }
  const settings = props.default_generation_settings as Record<string, unknown> | undefined;
  return {
    endpoint: base,
    engineBuild: props.build_info,
    modelPath: props.model_path,
    contextLimitTokens: settings?.n_ctx,
    chatTemplateDigest: digest(props.chat_template),
    tokenizerProbeDigest: digest(`${results.map((value) => JSON.stringify(value)).join("\n")}\n`),
    tokenizerProbeCount: corpus.length,
  };
}

const endpoints = (process.env.LARM_CONTEXT_SOURCE_ENDPOINTS
  ?? "http://127.0.0.1:8080,http://127.0.0.1:8083/upstream/qwen-quality")
  .split(",")
  .filter(Boolean);
const identities = [];
for (const endpoint of endpoints) identities.push(await identity(endpoint));
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  identities,
}, null, 2)}\n`);
