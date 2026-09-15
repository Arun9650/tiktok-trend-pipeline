import { resolveClipUrl, downloadBytes } from './resolveClip.js';
import { putObject } from './storage.js';

// Stage 3: Download & Raw Storage.
// Download each shortlisted video and store the untouched file in the raw
// bucket. Returns each item augmented with a `raw` storage location that
// Stage 4 reads from.

// A stable, filesystem/S3-safe key for a shortlisted video.
export function rawKeyFor(video) {
  const id = video.id || Buffer.from(video.webVideoUrl).toString('base64url').slice(0, 16);
  return `${video.sourceAccount || 'unknown'}/${id}.mp4`;
}

export async function downloadShortlist(shortlist) {
  const stored = [];
  for (const [i, video] of shortlist.entries()) {
    const label = `[${i + 1}/${shortlist.length}] @${video.sourceAccount}`;
    try {
      const clipUrl = await resolveClipUrl(video.webVideoUrl);
      const bytes = await downloadBytes(clipUrl);
      const raw = await putObject('raw', rawKeyFor(video), bytes);
      console.log(`  ${label} -> ${raw.url} (${(bytes.length / 1e6).toFixed(1)}MB)`);
      stored.push({ ...video, raw, rawBytes: bytes.length });
    } catch (err) {
      console.error(`  ${label} FAILED: ${err.message}`);
    }
  }
  return stored;
}
