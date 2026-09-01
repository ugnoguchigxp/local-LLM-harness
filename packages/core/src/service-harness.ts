import { z } from "zod";

export const SAAA_SERVICE_HARNESS_CONTRACT_VERSION = "saaa-service-harness.v2" as const;

export const saaaAsrServiceSchema = z.object({
  capability: z.literal("asr"),
  protocol: z.literal("openai.audio-transcriptions.v1"),
  baseUrl: z.string().url(),
  model: z.string().min(1).max(256),
  language: z.literal("auto"),
  healthUrl: z.string().url(),
  streaming: z.object({
    protocol: z.literal("saaa.asr-stream.v1"),
    url: z.string().url(),
    sampleRate: z.number().int().positive(),
    encoding: z.literal("pcm_s16le"),
    packetMilliseconds: z.number().int().positive(),
  }).strict().optional(),
}).strict();

export const saaaServiceHarnessSchema = z.object({
  contractVersion: z.literal(SAAA_SERVICE_HARNESS_CONTRACT_VERSION),
  revision: z.string().min(1).max(128),
  services: z.array(saaaAsrServiceSchema).max(32),
}).strict();

export const saaaAsrHealthSchema = z.object({
  status: z.literal("ok"),
  model: z.string().min(1).max(256),
}).strict();

export type SaaaAsrService = z.infer<typeof saaaAsrServiceSchema>;
export type SaaaServiceHarness = z.infer<typeof saaaServiceHarnessSchema>;
export type SaaaAsrHealth = z.infer<typeof saaaAsrHealthSchema>;
