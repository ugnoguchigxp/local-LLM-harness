import { expect, test } from "bun:test";
import { deriveMusicTags, listMusicTags } from "./music-tags";
import type { MusicTrack } from "./music";

test("automatic tags recognize Japanese and English tempo, mood, genre and instruments", () => {
  expect(deriveMusicTags({ prompt: "アップテンポで明るいピアノのポップ", instrumental: true })).toEqual(["アップテンポ", "明るい", "ポップ", "ピアノ", "インストゥルメンタル"]);
  expect(deriveMusicTags({ prompt: "Fast-paced uplifting jazz with piano", instrumental: false })).toEqual(["アップテンポ", "明るい", "ジャズ", "ピアノ"]);
  expect(deriveMusicTags({ prompt: "Slow, melancholy lo-fi guitar", instrumental: false })).toEqual(["ゆったり", "切ない", "ローファイ", "ギター"]);
  expect(deriveMusicTags({ prompt: "gentle electronic instrumental", instrumental: true })).toContain("落ち着いた");
});

test("automatic tags avoid common negations and unsupported descriptions", () => {
  expect(deriveMusicTags({ prompt: "No piano, not bright, without guitar. ギターなし。明るくない。暗くない。", instrumental: false })).toEqual([]);
  expect(deriveMusicTags({ prompt: "明るくテンポの速い曲", instrumental: false })).toEqual(["アップテンポ", "明るい"]);
  expect(deriveMusicTags({ prompt: "Ambient without piano. Bright piano chorus.", instrumental: false })).toEqual(["明るい", "アンビエント", "ピアノ"]);
  expect(deriveMusicTags({ prompt: "Something unusual", instrumental: false })).toEqual([]);
});

test("explicit tags are preserved, normalized duplicates removed and tag count bounded", () => {
  const request = { prompt: "happy piano", title: "アップテンポ", tags: ["Custom", "ＣＵＳＴＯＭ", "ピアノ"], instrumental: false };
  expect(deriveMusicTags(request)).toEqual(["Custom", "ピアノ", "アップテンポ", "明るい"]);
  const tags = Array.from({ length: 32 }, (_, i) => `manual${i}`);
  expect(deriveMusicTags({ ...request, tags })).toEqual(tags);
});

test("tag catalog counts songs once per normalized tag", () => {
  const tracks = [{ tags: ["Piano", "ＰＩＡＮＯ", "明るい"] }, { tags: ["piano"] }] as MusicTrack[];
  expect(listMusicTags(tracks)).toEqual({ tags: [{ tag: "Piano", count: 2 }, { tag: "明るい", count: 1 }], total: 2 });
});
