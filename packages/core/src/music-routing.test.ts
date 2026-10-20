import { expect, test } from "bun:test";
import { z } from "zod";
import { musicGenerationRequestSchema } from "./music";
import { resolveMusicRoute, STABLE_MUSIC_MODEL, STABLE_SFX_MODEL } from "./music-routing";

test("omitted duration selects usable defaults without changing vocal or explicit duration requests", () => {
  for (const [input, seconds, model] of [
    [{ instrumental: true }, 120, STABLE_MUSIC_MODEL],
    [{ model: STABLE_MUSIC_MODEL }, 120, STABLE_MUSIC_MODEL],
    [{ task: "sound-effect" }, 5, STABLE_SFX_MODEL],
    [{ model: STABLE_SFX_MODEL }, 5, STABLE_SFX_MODEL],
    [{}, 180, "acestep-v15-turbo"],
    [{ lyrics: "Words", instrumental: false }, 180, "acestep-v15-turbo"],
    [{ instrumental: true, durationSeconds: 121 }, 121, STABLE_MUSIC_MODEL],
    [{ task: "sound-effect", durationSeconds: 1.5 }, 1.5, STABLE_SFX_MODEL],
  ] as const) {
    const original = { prompt: "test", ...input };
    const before = { ...original };
    const parsed = musicGenerationRequestSchema.parse(Object.freeze(original));
    expect(parsed.durationSeconds).toBe(seconds);
    expect(resolveMusicRoute(parsed).model).toBe(model);
    expect(original).toEqual(before);
  }
  expect(() => resolveMusicRoute(musicGenerationRequestSchema.parse({ prompt: "test", model: STABLE_MUSIC_MODEL, instrumental: false }))).toThrow();
  for (const durationSeconds of [null, 0, NaN, 601]) {
    expect(musicGenerationRequestSchema.safeParse({ prompt: "test", instrumental: true, durationSeconds }).success).toBeFalse();
  }
  expect(musicGenerationRequestSchema.safeParse({ prompt: "test", model: STABLE_MUSIC_MODEL, lyrics: "Singing" }).success).toBeFalse();
});

test("context-dependent defaults preserve a strict machine-readable public request schema", () => {
  const schema = z.toJSONSchema(musicGenerationRequestSchema);
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBeFalse();
  expect(schema.properties?.durationSeconds).toMatchObject({ description: expect.stringContaining("sound effects 5 seconds") });
  for (const input of [null, [], "test", 42]) expect(musicGenerationRequestSchema.safeParse(input).success).toBeFalse();
});
