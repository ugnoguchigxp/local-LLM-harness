import type { MusicGenerationRequest, MusicTrack } from "./music";

const rules: readonly [string, RegExp][] = [
  ["アップテンポ", /\b(?:up[- ]?tempo|fast[- ]paced|fast tempo)\b|アップテンポ|(?:速|早)いテンポ|テンポ(?:が|の)?(?:速|早)/giu],
  ["ゆったり", /\b(?:slow|downtempo)\b|ゆったり|スローテンポ|ゆっくり/giu],
  ["明るい", /\b(?:bright|cheerful|happy|joyful|uplifting|upbeat)\b|明る(?:い|く|め)|陽気|楽しい|爽やか/giu],
  ["落ち着いた", /\b(?:calm|relaxing|soothing|peaceful|gentle|mellow)\b|落ち着いた|穏やか|リラックス/giu],
  ["暗い", /\b(?:dark|gloomy|somber|brooding)\b|暗(?:い|く|め)|陰鬱/giu],
  ["切ない", /\b(?:melancholy|melancholic|wistful|sad)\b|切ない|哀愁|悲しい/giu],
  ["力強い", /\b(?:powerful|energetic|dynamic)\b|力強い|パワフル|エネルギッシュ/giu],
  ["幻想的", /\b(?:dreamy|ethereal|atmospheric)\b|幻想的|夢幻/giu],
  ["ポップ", /\bpop\b|ポップ/giu],
  ["ロック", /\brock\b|ロック/giu],
  ["ジャズ", /\bjazz\b|ジャズ/giu],
  ["クラシック", /\bclassical\b|クラシック/giu],
  ["アンビエント", /\bambient\b|アンビエント/giu],
  ["ローファイ", /\blo[- ]?fi\b|ローファイ/giu],
  ["電子音楽", /\b(?:electronic|edm)\b|電子音楽|エレクトロニック/giu],
  ["ピアノ", /\bpiano\b|ピアノ/giu],
  ["ギター", /\bguitar\b|ギター/giu],
  ["ストリングス", /\bstrings\b|ストリングス|弦楽/giu],
  ["シンセサイザー", /\b(?:synth|synthesizer)\b|シンセ(?:サイザー)?/giu],
];

export function normalizeMusicText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function positiveMention(text: string, pattern: RegExp): boolean {
  // A fresh expression avoids shared lastIndex state across requests.
  return [...text.matchAll(new RegExp(pattern))].some((match) => {
    const before = text.slice(Math.max(0, match.index! - 48), match.index);
    const after = text.slice(match.index! + match[0].length);
    return !/\b(?:no|not|without|avoid|excluding|never|non)[\s-]+(?:\w+[\s-]+){0,2}$/iu.test(before)
      && !/^\s*(?:ない|なく|ではない|じゃない|ではなく|じゃなく|でない|なし|無し|を避け|は避け|不要)/u.test(after);
  });
}

// Tags describe the requested music, inferred only from explicit wording and
// the instrumental flag. This does not analyze the generated audio.
export function deriveMusicTags(request: Pick<MusicGenerationRequest, "prompt" | "title" | "tags" | "instrumental">): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const append = (tag: string) => {
    const key = normalizeMusicText(tag);
    if (result.length < 32 && !seen.has(key)) { result.push(tag); seen.add(key); }
  };
  for (const tag of request.tags ?? []) append(tag);
  const text = normalizeMusicText([request.title ?? "", request.prompt].join("\n"));
  for (const [tag, pattern] of rules) if (positiveMention(text, pattern)) append(tag);
  if (request.instrumental) append("インストゥルメンタル");
  return result;
}

export function musicTrackTagsMatch(track: MusicTrack, tags?: readonly string[]): boolean {
  const available = new Set(track.tags.map(normalizeMusicText));
  return (tags ?? []).every((tag) => available.has(normalizeMusicText(tag)));
}

export function listMusicTags(tracks: readonly MusicTrack[]) {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const track of tracks) {
    for (const key of new Set(track.tags.map(normalizeMusicText))) {
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { tag: track.tags.find((tag) => normalizeMusicText(tag) === key)!, count: 1 });
    }
  }
  return { tags: [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) };
}
