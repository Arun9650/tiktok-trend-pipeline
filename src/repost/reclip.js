import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from './config.js';
import { getObject, putObject } from './storage.js';
import { buildCaption, wrapCaption } from './caption.js';
import { extractEmoji, resolveEmojiImages } from './emoji.js';

const execFileAsync = promisify(execFile);

// Stage 4: Re-clip & Caption.
// Chop the raw source into a shorter hook clip and burn on a caption: small
// black text on a transparent background (ffmpeg drawtext), with any emoji
// overlaid as color PNGs in a centered row just below the text. Emoji are
// composited as images because neither drawtext nor libass renders color emoji
// on this ffmpeg build (they come out flat/monochrome). No new music here —
// that's Stage 5. Original audio is preserved.

// ffmpeg's filtergraph treats \ : and ' specially, and a Windows font path
// carries a drive-letter colon. Normalize slashes then escape those chars.
function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// We run ffmpeg with cwd set to the temp dir (so the drawtext textfile is a bare
// name needing no path escaping); a RELATIVE ffmpeg path like ./bin/ffmpeg.exe
// would then resolve against that temp dir and fail. Resolve it to absolute up
// front, but leave a bare command (e.g. "ffmpeg" on PATH) alone.
function resolveFfmpeg() {
  const p = config.ffmpegPath;
  if (!p.includes('/') && !p.includes('\\')) return p;
  return path.resolve(p);
}

// Probe the source's pixel dimensions by parsing `ffmpeg -i` output. Drawtext's
// fontsize must be a constant (it can't reference the frame height), so we size
// the caption from the real height to keep "small" consistent across source
// resolutions. Falls back to a vertical default if parsing fails.
async function getDimensions(inPath) {
  try {
    await execFileAsync(resolveFfmpeg(), ['-hide_banner', '-i', inPath]);
  } catch (err) {
    const s = `${err.stderr || ''}${err.stdout || ''}`;
    const m = s.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  }
  return { w: 1080, h: 1920 };
}

// Lightly randomized colour grade + micro-zoom applied BEFORE the caption, so
// every output is visually distinct from its source (and from other re-clips) —
// which is what defeats duplicate/recycled-content detection. Randomized so even
// two re-clips of one source aren't pixel-identical.
function uniquifyFilters() {
  const r = (min, max) => min + Math.random() * (max - min);
  const contrast = r(1.04, 1.12).toFixed(3);
  const saturation = r(1.12, 1.3).toFixed(3);
  const brightness = r(-0.03, 0.03).toFixed(3);
  const hue = r(-8, 8).toFixed(1);
  // Center-crop to 92–97% then let TikTok rescale = subtle zoom. floor-to-even
  // keeps dimensions valid for libx264 (odd width/height would fail the encode).
  const keep = r(0.92, 0.97).toFixed(4);
  return [
    `eq=contrast=${contrast}:saturation=${saturation}:brightness=${brightness}`,
    `hue=h=${hue}`,
    `crop=floor(iw*${keep}/2)*2:floor(ih*${keep}/2)*2`,
  ];
}

async function tmpDir() {
  const dir = path.join(os.tmpdir(), 'repost-reclip', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// A ready-bucket key derived from the raw one, so the edited clip is traceable
// back to its source.
function readyKeyFor(video) {
  const base = (video.raw?.key || `${video.sourceAccount}/${video.id}`).replace(/\.mp4$/, '');
  return `${base}-edited.mp4`;
}

/**
 * Assemble the ffmpeg args for one re-clip: trim, grade, black text, and the
 * color-emoji overlay row. Returns { args } ready to pass to ffmpeg (run with
 * cwd = `dir`, where cap.txt lives).
 */
function buildFfmpegArgs({ inPath, outPath, dims, wrapped, nLines, emojiImgs }) {
  const y = config.captionYFrac;
  const fontsize = Math.max(16, Math.round(dims.h * config.captionSizeFrac));
  const lineSpacing = Math.round(fontsize * 0.25);
  const lineAdvance = Math.round(fontsize * 1.3 + lineSpacing);
  const emojiSize = Math.round(fontsize * 1.2);
  const gap = Math.round(emojiSize * 0.28);

  const pre = config.uniquify ? uniquifyFilters() : [];
  if (wrapped) {
    const dt = [
      config.captionFontFile ? `fontfile='${escFilterPath(config.captionFontFile)}'` : null,
      'textfile=cap.txt',
      `fontcolor=${config.captionColor}`,
      `fontsize=${fontsize}`,
      `line_spacing=${lineSpacing}`,
      'text_align=C',
      'x=(w-text_w)/2',
      `y=h*${y}`,
    ].filter(Boolean).join(':');
    pre.push(`drawtext=${dt}`);
  }

  const parts = [];
  let base = '[0:v]';
  if (pre.length) {
    parts.push(`[0:v]${pre.join(',')}[base]`);
    base = '[base]';
  }

  // Emoji row, centered horizontally, sitting just below the text block.
  const n = emojiImgs.length;
  const rowW = n * emojiSize + (n - 1) * gap;
  const rowY = `${y}*main_h+${nLines * lineAdvance + (nLines ? gap : 0)}`;
  emojiImgs.forEach((_, i) => parts.push(`[${i + 1}:v]scale=${emojiSize}:${emojiSize}[e${i}]`));
  let cur = base;
  emojiImgs.forEach((_, i) => {
    const x = `(main_w-${rowW})/2+${i * (emojiSize + gap)}`;
    const out = i === n - 1 ? '[out]' : `[o${i}]`;
    parts.push(`${cur}[e${i}]overlay=x=${x}:y=${rowY}${out}`);
    cur = out;
  });

  const finalLabel = n ? '[out]' : base;

  const args = ['-y'];
  if (config.clipStartOffsetSec > 0) args.push('-ss', String(config.clipStartOffsetSec));
  args.push('-i', inPath);
  for (const e of emojiImgs) args.push('-i', e.img);
  args.push('-t', String(config.clipDurationSec));

  if (parts.length) {
    args.push('-filter_complex', parts.join(';'), '-map', finalLabel);
  } else {
    args.push('-map', '0:v');
  }
  args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', outPath);
  return args;
}

/**
 * Re-clip + caption one downloaded video. Returns the item augmented with a
 * `ready` storage location and the caption text that was burned in.
 */
export async function reclipOne(video) {
  if (!video.raw) throw new Error('video has no raw storage location (run Stage 3 first)');

  const rawBytes = await getObject(video.raw);
  const dir = await tmpDir();
  const inPath = path.join(dir, 'in.mp4');
  const outPath = path.join(dir, 'out.mp4');
  await fs.writeFile(inPath, rawBytes);

  // captionText is kept for metadata / the post description even when we don't
  // burn it onto the video (config.captionEnabled=false = filter-only clip).
  const captionText = buildCaption(video);
  const { text, emojis } = config.captionEnabled ? extractEmoji(captionText) : { text: '', emojis: [] };
  const wrapped = text ? wrapCaption(text, { perLine: 26, maxLines: 3 }) : '';
  const nLines = wrapped ? wrapped.split('\n').length : 0;
  if (wrapped) await fs.writeFile(path.join(dir, 'cap.txt'), wrapped, 'utf-8');

  const dims = await getDimensions(inPath);
  const emojiImgs = await resolveEmojiImages(emojis);
  if (emojis.length && emojiImgs.length < emojis.length) {
    console.log(`    note: ${emojis.length - emojiImgs.length} emoji couldn't be fetched, skipped.`);
  }

  const args = buildFfmpegArgs({ inPath, outPath, dims, wrapped, nLines, emojiImgs });
  await execFileAsync(resolveFfmpeg(), args, { cwd: dir });

  const editedBytes = await fs.readFile(outPath);
  const ready = await putObject('ready', readyKeyFor(video), editedBytes);

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  return { ...video, ready, caption: captionText, readyBytes: editedBytes.length };
}

export async function reclipAll(downloaded) {
  const edited = [];
  for (const [i, video] of downloaded.entries()) {
    const label = `[${i + 1}/${downloaded.length}] @${video.sourceAccount}`;
    try {
      const out = await reclipOne(video);
      console.log(`  ${label} -> ${out.ready.url}  caption: "${out.caption}"`);
      edited.push(out);
    } catch (err) {
      console.error(`  ${label} FAILED: ${err.message}`);
    }
  }
  return edited;
}
