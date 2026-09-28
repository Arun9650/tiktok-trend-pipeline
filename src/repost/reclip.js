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

// Probe the source's pixel dimensions and duration by parsing `ffmpeg -i`
// output. (`ffmpeg -i` with no output file always exits non-zero — "At least
// one output file must be specified" — so the info is read from the error's
// stderr, same as the single-clip path relied on.) Drawtext's fontsize must be
// a constant (it can't reference the frame height), so we size the caption from
// the real height to keep "small" consistent across source resolutions.
// Dimensions fall back to a vertical default; duration is left undefined if it
// can't be parsed (the caller then skips splitting).
async function probeMedia(inPath) {
  let s = '';
  try {
    await execFileAsync(resolveFfmpeg(), ['-hide_banner', '-i', inPath]);
  } catch (err) {
    s = `${err.stderr || ''}${err.stdout || ''}`;
  }
  const dm = s.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  const w = dm ? Number(dm[1]) : 1080;
  const h = dm ? Number(dm[2]) : 1920;
  const tm = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = tm ? Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) : undefined;
  return { w, h, duration };
}

// Decide how to split a source into sequential parts. When splitting is on and
// we know the duration, cut the usable span (after clipStartOffsetSec) into 2
// equal parts — or 3 when it runs longer than splitThresholdSec (default 60s).
// Without splitting (or a known duration) we fall back to one hook clip capped
// at clipDurationSec, preserving the original behavior.
function planSegments(duration) {
  const offset = Math.max(0, config.clipStartOffsetSec);
  const usable = (duration || 0) - offset;
  if (!config.splitParts || usable <= 0) {
    return [{ part: 1, partCount: 1, start: offset, duration: config.clipDurationSec }];
  }
  const partCount = usable > config.splitThresholdSec ? 3 : 2;
  const partLen = usable / partCount;
  return Array.from({ length: partCount }, (_, i) => ({
    part: i + 1,
    partCount,
    start: offset + i * partLen,
    duration: partLen,
  }));
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
// back to its source. Multi-part clips get a `-partNofM` suffix so each part is
// stored (and traceable) separately.
function readyKeyFor(video, part = 1, partCount = 1) {
  const base = (video.raw?.key || `${video.sourceAccount}/${video.id}`).replace(/\.mp4$/, '');
  return partCount > 1 ? `${base}-edited-part${part}of${partCount}.mp4` : `${base}-edited.mp4`;
}

/**
 * Assemble the ffmpeg args for one re-clip: trim, grade, black text, and the
 * color-emoji overlay row. Returns { args } ready to pass to ffmpeg (run with
 * cwd = `dir`, where cap.txt lives).
 */
function buildFfmpegArgs({ inPath, outPath, dims, wrapped, nLines, emojiImgs, start, duration }) {
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
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', inPath);
  for (const e of emojiImgs) args.push('-i', e.img);
  args.push('-t', String(duration));

  if (parts.length) {
    args.push('-filter_complex', parts.join(';'), '-map', finalLabel);
  } else {
    args.push('-map', '0:v');
  }
  args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', outPath);
  return args;
}

/**
 * Re-clip + caption one downloaded video. Splits the source into sequential
 * parts (see planSegments — 2 by default, 3 when it runs long) and renders each
 * as its own edited clip. Returns an ARRAY of items, one per part, each with its
 * own `ready` storage location and post caption. Downstream stages treat each
 * part as a separate post, so the parts get scheduled 3h apart as a series.
 */
export async function reclipOne(video) {
  if (!video.raw) throw new Error('video has no raw storage location (run Stage 3 first)');

  const rawBytes = await getObject(video.raw);
  const dir = await tmpDir();
  const inPath = path.join(dir, 'in.mp4');
  await fs.writeFile(inPath, rawBytes);

  // captionText is kept for metadata / the post description even when we don't
  // burn it onto the video (config.captionEnabled=false = filter-only clip).
  const captionText = buildCaption(video);
  const { text, emojis } = config.captionEnabled ? extractEmoji(captionText) : { text: '', emojis: [] };
  const wrapped = text ? wrapCaption(text, { perLine: 26, maxLines: 3 }) : '';
  const nLines = wrapped ? wrapped.split('\n').length : 0;
  if (wrapped) await fs.writeFile(path.join(dir, 'cap.txt'), wrapped, 'utf-8');

  const media = await probeMedia(inPath);
  const dims = { w: media.w, h: media.h };
  const emojiImgs = await resolveEmojiImages(emojis);
  if (emojis.length && emojiImgs.length < emojis.length) {
    console.log(`    note: ${emojis.length - emojiImgs.length} emoji couldn't be fetched, skipped.`);
  }

  const segments = planSegments(media.duration);
  const results = [];
  for (const seg of segments) {
    const outPath = path.join(dir, `out-${seg.part}.mp4`);
    const args = buildFfmpegArgs({
      inPath, outPath, dims, wrapped, nLines, emojiImgs, start: seg.start, duration: seg.duration,
    });
    await execFileAsync(resolveFfmpeg(), args, { cwd: dir });

    const editedBytes = await fs.readFile(outPath);
    const ready = await putObject('ready', readyKeyFor(video, seg.part, seg.partCount), editedBytes);
    // Tag the post description with the part number so a viewer sees it as a
    // series ("Part 1/3"). The burned-in hook caption is unchanged.
    const caption = seg.partCount > 1 ? `${captionText} (Part ${seg.part}/${seg.partCount})` : captionText;
    results.push({
      ...video, ready, caption, readyBytes: editedBytes.length, part: seg.part, partCount: seg.partCount,
    });
  }

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  return results;
}

export async function reclipAll(downloaded) {
  const edited = [];
  for (const [i, video] of downloaded.entries()) {
    const label = `[${i + 1}/${downloaded.length}] @${video.sourceAccount}`;
    try {
      const parts = await reclipOne(video);
      for (const out of parts) {
        const tag = out.partCount > 1 ? ` part ${out.part}/${out.partCount}` : '';
        console.log(`  ${label}${tag} -> ${out.ready.url}  caption: "${out.caption}"`);
        edited.push(out);
      }
    } catch (err) {
      console.error(`  ${label} FAILED: ${err.message}`);
    }
  }
  return edited;
}
