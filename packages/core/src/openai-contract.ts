import { z } from "zod";

export const chatCompletionResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).passthrough(),
  z.object({ type: z.literal("json_object") }).passthrough(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().min(1).max(128).optional(),
      description: z.string().max(1024).optional(),
      strict: z.boolean().optional(),
      schema: z.record(z.string(), z.unknown()),
    }).passthrough(),
  }).passthrough(),
]);

export const chatCompletionContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().min(1), detail: z.enum(["auto", "low", "high"]).optional() }).passthrough() }).passthrough(),
]);
export const chatCompletionMessageSchema = z.object({
  role: z.string().min(1),
  content: z.union([z.string(), z.array(chatCompletionContentPartSchema), z.null()]).optional(),
}).passthrough();

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatCompletionMessageSchema),
  stream: z.boolean().optional(),
  // Standard OpenAI field. It is a cache namespace, never an authentication token.
  prompt_cache_key: z.string().max(1024).nullable().optional(),
  response_format: chatCompletionResponseFormatSchema.optional(),
}).passthrough();

export const audioSpeechRequestSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1).optional(),
  style: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  response_format: z.string().min(1).optional(),
  speed: z.number().finite().positive().optional(),
  pitch_scale: z.number().finite().min(-0.15).max(0.15).optional(),
  intonation_scale: z.number().finite().min(0).max(2).optional(),
}).passthrough();

const audioVoiceControlRangeSchema = z.object({
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  default: z.number().finite(),
}).strict().superRefine((value, context) => {
  if (value.minimum > value.maximum) {
    context.addIssue({ code: "custom", message: "minimum must not exceed maximum" });
  }
  if (value.default < value.minimum || value.default > value.maximum) {
    context.addIssue({ code: "custom", message: "default must be within the advertised range" });
  }
});

export const audioVoiceStyleSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  style_id: z.number().int().nonnegative(),
}).strict();

export const audioVoiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  display_name: z.string().min(1),
  speaker_uuid: z.string().min(1),
  voice_presentation: z.enum(["masculine", "feminine", "androgynous", "unspecified"]),
  language: z.literal("ja"),
  default_style: z.string().min(1),
  style_id: z.number().int().nonnegative(),
  styles: z.array(audioVoiceStyleSchema).min(1),
  capabilities: z.object({
    speed: audioVoiceControlRangeSchema,
    pitch_scale: audioVoiceControlRangeSchema,
    intonation_scale: audioVoiceControlRangeSchema,
  }).strict(),
  credit: z.string().min(1),
}).strict().superRefine((value, context) => {
  const styleIds = value.styles.map((style) => style.id);
  const numericStyleIds = value.styles.map((style) => style.style_id);
  if (new Set(styleIds).size !== styleIds.length) {
    context.addIssue({ code: "custom", path: ["styles"], message: "style ids must be unique" });
  }
  if (new Set(numericStyleIds).size !== numericStyleIds.length) {
    context.addIssue({ code: "custom", path: ["styles"], message: "numeric style ids must be unique" });
  }
  const defaultStyle = value.styles.find((style) => style.id === value.default_style);
  if (!defaultStyle) {
    context.addIssue({ code: "custom", path: ["default_style"], message: "default style must be advertised" });
  } else if (defaultStyle.style_id !== value.style_id) {
    context.addIssue({ code: "custom", path: ["style_id"], message: "style_id must identify the default style" });
  }
});

export const audioVoiceListSchema = z.object({
  default_voice: z.string().min(1),
  voices: z.array(audioVoiceSchema),
}).strict().superRefine((value, context) => {
  const voiceIds = value.voices.map((voice) => voice.id);
  if (new Set(voiceIds).size !== voiceIds.length) {
    context.addIssue({ code: "custom", path: ["voices"], message: "voice ids must be unique" });
  }
  if (!voiceIds.includes(value.default_voice)) {
    context.addIssue({ code: "custom", path: ["default_voice"], message: "default voice must be advertised" });
  }
});

// Providers without VOICEVOX's numeric speaker/style identifiers still expose
// deterministic voice selection and only the controls they actually support.
const audioProviderVoiceListSchema = z.object({
  default_voice: z.string().min(1),
  voices: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    display_name: z.string().min(1),
    language: z.string().min(1),
    voice_presentation: z.enum(["masculine", "feminine", "androgynous", "unspecified"]),
    styles: z.array(z.object({
      id: z.string().min(1), display_name: z.string().min(1),
    }).strict()),
    capabilities: z.object({
      speed: audioVoiceControlRangeSchema.optional(),
      pitch_scale: audioVoiceControlRangeSchema.optional(),
      intonation_scale: audioVoiceControlRangeSchema.optional(),
    }).strict(),
  }).strict()),
}).strict().superRefine((value, context) => {
  const ids = value.voices.map((voice) => voice.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["voices"], message: "voice ids must be unique" });
  }
  if (!ids.includes(value.default_voice)) {
    context.addIssue({ code: "custom", path: ["default_voice"], message: "default voice must be advertised" });
  }
  for (const [index, voice] of value.voices.entries()) {
    if (new Set(voice.styles.map((style) => style.id)).size !== voice.styles.length) {
      context.addIssue({ code: "custom", path: ["voices", index, "styles"], message: "style ids must be unique" });
    }
  }
});

export const audioVoiceDiscoverySchema = z.union([
  audioVoiceListSchema,
  audioProviderVoiceListSchema,
  z.object({
    voices: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      language: z.string().min(1).nullable().optional(),
      description: z.string().nullable().optional(),
    }).strict()),
    languages: z.array(z.string().min(1)).optional(),
  }).strict(),
]);

export type AudioSpeechRequest = z.input<typeof audioSpeechRequestSchema>;
export type AudioVoice = z.infer<typeof audioVoiceSchema>;
export type AudioVoiceList = z.infer<typeof audioVoiceListSchema>;
