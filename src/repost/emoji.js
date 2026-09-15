import path from 'path';
import fs from 'fs/promises';
import { config } from './config.js';

// Color-emoji support for the burned-in caption.
//
// ffmpeg's text renderers (drawtext AND libass) render emoji as flat monochrome
// glyphs on this build — they can't composite a color emoji font. So to show
// emoji IN COLOR we overlay real color-emoji PNGs onto the video instead. The
// images come from a CDN by codepoint and are cached locally.
//
// Licensing note: the default set is Apple-style artwork (via the widely-used
// `emoji-datasource-apple` package mirror). Apple's emoji designs are Apple's
// IP; this redistributes them the way countless web apps do, but if that's a
// concern set REPOST_EMOJI_STYLE=twemoji for the freely-licensed Twemoji set.

const CDN = {
  apple: 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/{code}.png',
  twemoji: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/{code}.png',
};

const cdnTemplate = () =>
  config.emojiCdn || CDN[config.emojiStyle] || CDN.apple;

// Cache under the (git-ignored) repost-data dir so repeated renders don't re-hit
// the CDN for the same emoji.
const CACHE_DIR = './repost-data/.emoji-cache';

// Grapheme-segment the caption so multi-codepoint emoji (ZWJ sequences, flags,
// skin tones) are treated as one unit, then split into plain text vs. emoji.
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * Split a caption into its text (emoji removed) and the ordered list of emoji.
 * @returns {{ text: string, emojis: {char: string, code: string}[] }}
 */
export function extractEmoji(caption) {
  let text = '';
  const emojis = [];
  for (const { segment } of segmenter.segment(String(caption))) {
    if (EMOJI_RE.test(segment)) {
      emojis.push({ char: segment, code: codeFor(segment) });
    } else {
      text += segment;
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), emojis };
}

// Codepoint filename: lowercase hex codepoints joined by '-', dropping the FE0F
// variation selector (matches how both emoji sets name their files). ZWJ (200d)
// is kept so family/sequence emoji resolve to their combined image.
function codeFor(emojiChar) {
  return [...emojiChar]
    .map((c) => c.codePointAt(0).toString(16))
    .filter((h) => h !== 'fe0f')
    .join('-');
}

/**
 * Ensure a color PNG for `code` exists locally; return its path, or null if it
 * can't be fetched (unknown emoji / offline) so the caller can just skip it.
 */
export async function emojiImage(code) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  // Absolute path: reclip.js runs ffmpeg with cwd = a temp dir, so a relative
  // path here would be resolved against that temp dir and not found.
  const dest = path.resolve(CACHE_DIR, `${config.emojiStyle}-${code}.png`);
  if (await fs.stat(dest).then(() => true).catch(() => false)) return dest;

  const url = cdnTemplate().replace('{code}', code);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    // Guard against a CDN error page sneaking in as a "success".
    if (bytes.length < 100 || bytes.slice(1, 4).toString() !== 'PNG') return null;
    await fs.writeFile(dest, bytes);
    return dest;
  } catch {
    return null;
  }
}

/** Resolve every emoji in a caption to a local PNG path (skips any that fail). */
export async function resolveEmojiImages(emojis) {
  const out = [];
  for (const e of emojis) {
    const img = await emojiImage(e.code);
    if (img) out.push({ ...e, img });
  }
  return out;
}
