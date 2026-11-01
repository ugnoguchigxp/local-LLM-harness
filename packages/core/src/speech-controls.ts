import { z } from "zod";
import type { AudioSpeechRequest } from "./openai-contract";

const range = z.object({
  minimum: z.number().finite(), maximum: z.number().finite(), default: z.number().finite(),
}).strict().refine(v => v.minimum <= v.default && v.default <= v.maximum,
  "speech control default must be inside its range");

export const speechControlsSchema = z.object({
  speed: range.optional(), pitch_scale: range.optional(), intonation_scale: range.optional(),
  style: z.boolean().default(false),
}).strict();

export type SpeechControls = z.infer<typeof speechControlsSchema>;

/** Validate against the resolved runtime, never a model-name heuristic. */
export function inspectSpeechControls(controls: SpeechControls | undefined, request: AudioSpeechRequest):
  { code: "invalid_request" | "unsupported_parameter"; message: string; param: string } | undefined {
  for (const param of ["speed", "pitch_scale", "intonation_scale"] as const) {
    const value = request[param];
    if (value === undefined) continue;
    const supported = controls?.[param];
    // Preserve the existing generic OpenAI speed path for runtimes without metadata.
    if (!supported && param === "speed" && controls === undefined) continue;
    if (!supported) return { code: "unsupported_parameter", message: `${param} is not supported by this TTS provider`, param };
    if (value < supported.minimum || value > supported.maximum) {
      return { code: supported.minimum === supported.maximum ? "unsupported_parameter" : "invalid_request",
        message: `${param} must be between ${supported.minimum} and ${supported.maximum}`, param };
    }
  }
  if (request.style !== undefined && controls?.style !== true) {
    return { code: "unsupported_parameter", message: "style is not supported by this TTS provider", param: "style" };
  }
}
