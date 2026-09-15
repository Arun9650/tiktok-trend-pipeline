import 'dotenv/config';

// Central config for the repost pipeline (PRD: Content Sourcing & Auto-Repost).
// This pipeline is deliberately SEPARATE from the generation pipeline in
// src/index.js — it sources existing high-performing videos, re-edits them, and
// reposts them, rather than generating originals from a script. Everything here
// reads from .env with sensible defaults so the pipeline is runnable end-to-end
// without touching code (see .env.example for the full list).

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true');
const list = (v, d = []) =>
  (v ? v.split(',') : d).map((s) => s.trim()).filter(Boolean);

export const config = {
  // --- Apify (Stage 1-2 scanning) ---
  apifyToken: process.env.APIFY_TOKEN,
  // clockworks/tiktok-scraper handles profiles, hashtags, and search in one
  // actor, so both stages reuse it rather than juggling multiple data sources.
  scraperActorId: process.env.APIFY_ACTOR_ID || 'clockworks~tiktok-scraper',

  // --- Stage 0 default inputs (also settable per-run via the UI/CLI) ---
  // Comma-separated. Handles may be given with or without a leading @.
  inputAccounts: list(process.env.REPOST_ACCOUNTS),
  inputHashtags: list(process.env.REPOST_HASHTAGS),
  inputNames: list(process.env.REPOST_NAMES),

  // --- Volume caps (open question in PRD: volume per run). Kept low so a
  // pilot run is cheap and the 3h cadence isn't blown through in one batch. ---
  maxAccounts: num(process.env.REPOST_MAX_ACCOUNTS, 5),
  searchResultsPerTerm: num(process.env.REPOST_SEARCH_RESULTS, 15),
  videosPerAccount: num(process.env.REPOST_VIDEOS_PER_ACCOUNT, 30),
  topVideosPerAccount: num(process.env.REPOST_TOP_VIDEOS_PER_ACCOUNT, 3),
  minPlayCount: num(process.env.REPOST_MIN_PLAYS, 10000),
  // Process one video per gather run by default. On a 3h cadence there's no
  // reason to download/edit a big batch up front — take only the single best
  // video across all scanned accounts, push it through, done. Raise this once
  // the pilot is proven and you want to build up a queue in one run.
  maxOutputsPerRun: num(process.env.REPOST_MAX_OUTPUTS_PER_RUN, 1),

  // --- Storage (Stage 3-4). Two logical buckets per the PRD. If AWS creds are
  // absent we fall back to local dirs so the pipeline still runs on a laptop. ---
  s3Region: process.env.AWS_REGION || 'us-east-1',
  rawBucket: process.env.REPOST_RAW_BUCKET, // raw downloads
  readyBucket: process.env.REPOST_READY_BUCKET, // edited / ready-to-post
  localRawDir: process.env.REPOST_LOCAL_RAW_DIR || './repost-data/raw',
  localReadyDir: process.env.REPOST_LOCAL_READY_DIR || './repost-data/ready',

  // --- Stage 4 editing ---
  ffmpegPath: process.env.FFMPEG_PATH || './bin/ffmpeg.exe',
  // Max length of the re-cut clip in seconds (Opus-Clip-style chop of the hook).
  clipDurationSec: num(process.env.REPOST_CLIP_SECONDS, 30),
  // Trim this many seconds off the very start (intros rarely hook). 0 = keep.
  clipStartOffsetSec: num(process.env.REPOST_CLIP_START, 0),
  // Burned-in caption style. Small black text on a transparent background,
  // drawn with ffmpeg drawtext; emoji are overlaid separately as color PNGs
  // (see emoji.js) because neither drawtext nor libass renders color emoji on
  // this build. Font is a .ttf FILE path (drawtext needs a file, not a family).
  captionFontFile:
    process.env.REPOST_CAPTION_FONT ||
    (process.platform === 'win32' ? 'C:/Windows/Fonts/arialbd.ttf' : ''),
  // Font size as a fraction of frame height, so "small" stays small regardless
  // of the source resolution. ~0.033 is a small, clean caption.
  captionSizeFrac: num(process.env.REPOST_CAPTION_SIZE, 0.033),
  captionColor: process.env.REPOST_CAPTION_COLOR || 'black',
  // Vertical position of the caption block as a fraction from the top.
  // Default 0.68 = lower third (subtitle-style, keeps the subject clear).
  captionYFrac: num(process.env.REPOST_CAPTION_Y, 0.68),
  // Color-emoji artwork set: 'apple' (Apple-style; see licensing note in
  // emoji.js) or 'twemoji' (freely licensed). REPOST_EMOJI_CDN overrides the
  // URL template entirely (must contain {code}).
  emojiStyle: process.env.REPOST_EMOJI_STYLE || 'apple',
  emojiCdn: process.env.REPOST_EMOJI_CDN,
  // Make every output visually distinct from its source (and from other
  // re-clips) so TikTok's duplicate/recycled-content detection doesn't flag a
  // repost. Applies a lightly randomized colour grade + micro-zoom per render,
  // on top of the caption burn-in and full re-encode. Same idea the generation
  // pipeline uses; set false to post the source pixels closer to untouched.
  uniquify: bool(process.env.REPOST_UNIQUIFY, true),

  // --- Stage 5 trending sounds ---
  // Where "today's best music" comes from (PRD open question). Two options:
  //  'discovered' — reuse the top sounds already found on the scanned videos
  //                 (free, no extra call, and provably trending in this niche).
  //  'apify'      — a dedicated Apify trending-sounds actor run (needs actor id).
  trendingSoundSource: process.env.REPOST_SOUND_SOURCE || 'discovered',
  trendingSoundActorId: process.env.REPOST_SOUND_ACTOR_ID,

  // --- Stage 6 posting ---
  requireApproval: bool(process.env.REPOST_REQUIRE_APPROVAL, true),
  blotatoApiKey: process.env.BLOTATO_API_KEY,
  // The pilot account (PRD: one account first). Blotato account id to post to.
  blotatoAccountId: process.env.REPOST_BLOTATO_ACCOUNT_ID || process.env.BLOTATO_TIKTOK_ACCOUNT_ID,
  // Hard rule from the PRD: min 3h between posts on the same account.
  minGapHours: num(process.env.REPOST_MIN_GAP_HOURS, 3),
  maxPostsPerDay: num(process.env.REPOST_MAX_POSTS_PER_DAY, 4),
  dryRun: bool(process.env.REPOST_DRY_RUN, false),

  // Web UI port (Stage 0).
  uiPort: num(process.env.REPOST_UI_PORT, 3100),
};

// Stable identity for a source video, used to guarantee we never process or
// repost the same source twice across runs. Prefers the TikTok video id, falls
// back to its canonical URL.
export const sourceKey = (v) => String(v?.id || v?.webVideoUrl || '');

// Normalize a handle: strip a leading @ and any profile-URL wrapping, lowercase.
export function normalizeHandle(raw) {
  if (!raw) return null;
  let h = String(raw).trim();
  const urlMatch = h.match(/tiktok\.com\/@([\w.]+)/i);
  if (urlMatch) h = urlMatch[1];
  h = h.replace(/^@/, '').trim().toLowerCase();
  return h || null;
}

export default config;
