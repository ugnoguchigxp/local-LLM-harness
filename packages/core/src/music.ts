import { z } from "zod";

const identifierSchema = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const musicOutputFormatSchema = z.enum(["wav", "flac", "mp3", "opus"]);
export const musicQualitySchema = z.enum(["fast", "balanced", "high"]);
export const musicGenerationStatusSchema = z.enum([
  "queued",
  "loading",
  "generating",
  "encoding",
  "completed",
  "failed",
  "cancelled",
]);

export const musicGenerationRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  prompt: z.string().trim().min(1).max(16_384),
  lyrics: z.string().max(131_072).optional(),
  durationSeconds: z.number().int().min(1).max(600).default(180),
  instrumental: z.boolean().default(false),
  language: z.string().min(2).max(32).optional(),
  bpm: z.number().int().min(20).max(300).optional(),
  key: z.string().min(1).max(32).optional(),
  timeSignature: z.string().regex(/^\d{1,2}(?:\/\d{1,2})?$/).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  referenceAudio: z.string().url().optional(),
  outputFormat: musicOutputFormatSchema.default("opus"),
  quality: musicQualitySchema.default("balanced"),
  model: identifierSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((request, context) => {
  if (request.instrumental && request.lyrics) {
    context.addIssue({
      code: "custom",
      path: ["lyrics"],
      message: "lyrics must be omitted for instrumental generation",
    });
  }
});

export const musicProviderCapabilitiesSchema = z.object({
  instrumental: z.boolean(),
  vocals: z.boolean(),
  lyrics: z.boolean(),
  referenceAudio: z.boolean(),
  remix: z.boolean(),
  cover: z.boolean(),
  repaint: z.boolean(),
  stemSeparation: z.boolean(),
  bpmControl: z.boolean(),
  keyControl: z.boolean(),
  maxDurationSeconds: z.number().positive().optional(),
  qualityProfile: z.enum(["fast", "balanced", "high"]),
  speedProfile: z.enum(["fast", "balanced", "slow"]),
}).strict();

export const musicGenerationResultSchema = z.object({
  id: identifierSchema,
  provider: identifierSchema,
  model: identifierSchema,
  audioUrl: z.string().startsWith("/"),
  metadataUrl: z.string().startsWith("/"),
  durationSeconds: z.number().positive(),
  format: musicOutputFormatSchema,
  seed: z.number().int().nonnegative().optional(),
  generationTimeMs: z.number().int().nonnegative(),
  realtimeFactor: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const musicGenerationJobSchema = z.object({
  jobId: identifierSchema,
  status: musicGenerationStatusSchema,
  phase: musicGenerationStatusSchema,
  progress: z.number().min(0).max(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  result: musicGenerationResultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();

export const musicProviderHealthSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
}).strict();

export const musicProviderListSchema = z.object({
  providers: z.array(z.object({
    id: identifierSchema,
    capabilities: musicProviderCapabilitiesSchema,
    health: musicProviderHealthSchema,
  }).strict()),
}).strict();

export const musicArtifactMetadataSchema = musicGenerationResultSchema.extend({
  audioFile: z.string().min(1).max(255),
  prompt: z.string().min(1).max(16_384),
  lyrics: z.string().max(131_072).optional(),
  request: musicGenerationRequestSchema,
  createdAt: z.string().datetime(),
  favorite: z.boolean().default(false),
  favoritedAt: z.string().datetime().optional(),
}).strict();

export const musicFavoriteSchema = z.object({
  jobId: identifierSchema,
  audioUrl: z.string().startsWith("/"),
  metadataUrl: z.string().startsWith("/"),
  format: musicOutputFormatSchema,
  durationSeconds: z.number().positive(),
  model: identifierSchema,
  createdAt: z.string().datetime(),
  favoritedAt: z.string().datetime(),
}).strict();

export const musicFavoriteListSchema = z.object({
  favorites: z.array(musicFavoriteSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
}).strict();

export const musicTrackSchema = z.object({
  id: identifierSchema,
  title: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(64)).max(32),
  prompt: z.string().min(1).max(16_384),
  lyrics: z.string().max(131_072).optional(),
  instrumental: z.boolean(),
  language: z.string().optional(),
  provider: identifierSchema,
  model: identifierSchema,
  format: musicOutputFormatSchema,
  durationSeconds: z.number().positive(),
  createdAt: z.string().datetime(),
  favorite: z.boolean(),
  favoritedAt: z.string().datetime().optional(),
  audioUrl: z.string().startsWith("/"),
  metadataUrl: z.string().startsWith("/"),
}).strict();

export const musicTrackQuerySchema = z.object({
  q: z.string().trim().max(512).optional(),
  tags: z.string().max(512).transform((value) => value.split(",").map((tag) => tag.trim()))
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(32)).optional(),
  sort: z.enum(["createdAt", "relevance"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  favorite: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(8192).optional(),
}).strict();

export const musicFavoriteQuerySchema = musicTrackQuerySchema.pick({ q: true, tags: true, limit: true, cursor: true });
export const musicTagQuerySchema = musicTrackQuerySchema.pick({ limit: true, cursor: true });

export const musicTrackListSchema = z.object({
  tracks: z.array(musicTrackSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
}).strict();

export const musicTagListSchema = z.object({
  tags: z.array(z.object({ tag: z.string().min(1).max(64), count: z.number().int().positive() }).strict()),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
}).strict();

export type MusicTrack = z.infer<typeof musicTrackSchema>;
export type MusicTrackQuery = z.infer<typeof musicTrackQuerySchema>;
export type MusicTrackList = z.infer<typeof musicTrackListSchema>;
export type MusicFavoriteQuery = z.infer<typeof musicFavoriteQuerySchema>;
export type MusicTagQuery = z.infer<typeof musicTagQuerySchema>;

export type MusicGenerationRequest = z.infer<typeof musicGenerationRequestSchema>;
export type MusicGenerationStatus = z.infer<typeof musicGenerationStatusSchema>;
export type MusicGenerationResult = z.infer<typeof musicGenerationResultSchema>;
export type MusicGenerationJob = z.infer<typeof musicGenerationJobSchema>;
export type MusicProviderCapabilities = z.infer<typeof musicProviderCapabilitiesSchema>;
export type MusicFavorite = z.infer<typeof musicFavoriteSchema>;

export type MusicGenerationContext = {
  jobId: string;
  signal: AbortSignal;
  phase: (phase: MusicGenerationStatus, progress?: number) => void;
};

export interface MusicProvider {
  readonly id: string;
  readonly capabilities: MusicProviderCapabilities;
  load(): Promise<void>;
  unload(): Promise<void>;
  generate(
    request: MusicGenerationRequest,
    context: MusicGenerationContext,
  ): Promise<Omit<MusicGenerationResult, "id" | "provider" | "audioUrl" | "metadataUrl"> & {
    audio: Uint8Array;
    release?: () => Promise<void>;
  }>;
  cancel?(jobId: string): Promise<void>;
  health(): Promise<{ available: boolean; reason?: string }>;
}
