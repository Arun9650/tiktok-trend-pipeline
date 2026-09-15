// Build the big burned-in hook caption for a re-clipped video (PRD Stage 4).
// Open question in the PRD: auto-generate the caption text, or pull it from the
// original video's context. We do the latter — derive a short, punchy hook from
// the source video's own caption text — because it needs no extra API call and
// stays on-topic with the clip. REPOST_CAPTION_OVERRIDE forces a fixed caption
// for testing.

const STOP_PREFIXES = [/^replying to /i, /^#/];

/**
 * Turn a source video's caption into a short overlay hook: strip hashtags,
 * mentions, and "replying to @x" noise, collapse whitespace, and cap length so
 * it fits as a couple of large on-screen lines.
 */
export function buildCaption(video, { maxChars = 70 } = {}) {
  if (process.env.REPOST_CAPTION_OVERRIDE) return process.env.REPOST_CAPTION_OVERRIDE;

  let text = String(video.text || '')
    .replace(/#[\w]+/g, '') // drop hashtags
    .replace(/@[\w.]+/g, '') // drop mentions
    .replace(/https?:\/\/\S+/g, '') // drop urls
    .replace(/\s+/g, ' ')
    .trim();

  for (const re of STOP_PREFIXES) text = text.replace(re, '').trim();

  // Nothing usable in the source caption — fall back to a generic curiosity hook
  // rather than shipping an empty overlay.
  if (!text) return 'Watch till the end 👀';

  if (text.length > maxChars) {
    // Cut on a word boundary near the limit so we don't slice a word in half.
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
  }
  return text;
}

/**
 * Greedy word-wrap into at most `maxLines` lines of roughly `perLine` chars,
 * for the fixed-width overlay box. drawtext won't wrap on its own.
 */
export function wrapCaption(text, { perLine = 22, maxLines = 3 } = {}) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > perLine && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).join('\n');
}
