import { readFile } from "node:fs/promises";
import { LarmClient } from "../packages/client/src/index";

const audioPath = process.env.LARM_CANARY_AUDIO_FILE;
if (!audioPath) throw new Error("LARM_CANARY_AUDIO_FILE is required");
const client = new LarmClient({
  baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});

await client.withAllocation({
  requirements: [
    { capability: "speech.stt", route: "stt-default" },
    { capability: "llm.general", route: "llm-default" },
    { capability: "speech.tts", route: "tts-default" },
  ],
  allowFallback: false,
  deploymentPolicy: "existing-only",
  ttlSeconds: 180,
}, async (allocation, larm) => {
  const form = new FormData();
  form.set("file", new Blob([await readFile(audioPath)]), "sample.wav");
  const transcript = await (await larm.transcribe(allocation.id, form)).json() as { text: string };
  const completion = await (await larm.chat(allocation.id, {
    model: "larm",
    stream: false,
    messages: [{ role: "user", content: transcript.text }],
  })).json() as { choices?: Array<{ message?: { content?: string } }> };
  const speech = await larm.speech(allocation.id, {
    model: "voicevox-core",
    voice: "Kasukabe_Tsumugi",
    response_format: "wav",
    input: completion.choices?.[0]?.message?.content ?? "応答を生成できませんでした。",
  });
  console.log(JSON.stringify({
    allocation: allocation.id,
    runtimeBindings: allocation.bindings.map(({ capability, route, runtime, release }) => ({
      capability,
      route,
      runtime,
      release,
    })),
    speechBytes: (await speech.arrayBuffer()).byteLength,
  }));
});
