import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const OUTPUT_DIR = './rendered-videos';
const APPROVED_DIR = './approved-scripts';
const WORK_DIR = './remotion/public';

// ffmpeg color grade. eq brightness/contrast/saturation + a slight hue shift,
// matching the old on-screen look. Tweak these to taste.
const COLOR_FILTER = 'eq=contrast=1.15:saturation=1.35:brightness=-0.05,hue=h=-6';

// TikTok's CDN rejects requests without a browser-like User-Agent.
const DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function downloadTo(url, destPath) {
  const res = await fetch(url, { headers: DOWNLOAD_HEADERS });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Full ffmpeg (color filters like eq/hue need the complete build; Remotion's
// bundled ffmpeg is stripped to ~50 filters with no color grading). Set
// FFMPEG_PATH to override, or drop a static ffmpeg.exe in ./bin.
const FFMPEG = process.env.FFMPEG_PATH || './bin/ffmpeg.exe';

// TikTok blocks direct/automated downloads from most IPs, and its scraped CDN
// links expire in hours. tikwm resolves a public webVideoUrl to a fresh
// no-watermark mp4 on its own (non-blocked) CDN, no cookies or API key.
// ponytail: free public API, add own resolver only if it rate-limits/dies.
async function resolveClipUrl(webVideoUrl) {
  const res = await fetch(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(webVideoUrl)}`);
  if (!res.ok) throw new Error(`tikwm request failed (${res.status})`);
  const { code, msg, data } = await res.json();
  if (code !== 0 || !data?.play) throw new Error(`tikwm could not resolve clip: ${msg || 'no video url'}`);
  const url = data.hdplay || data.play;
  return url.startsWith('http') ? url : `https://www.tikwm.com${url}`;
}

async function findLatestApprovedScript() {
  const files = await fs.readdir(APPROVED_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error(`No approved scripts found in ${APPROVED_DIR}. Run the pipeline and approve one via Telegram first.`);
  }
  // Filenames are timestamp-prefixed, so a plain sort puts the newest one last.
  jsonFiles.sort();
  return path.join(APPROVED_DIR, jsonFiles[jsonFiles.length - 1]);
}

async function main() {
  const scriptPath = process.argv[2] || (await findLatestApprovedScript());
  console.log(`Source clip from: ${scriptPath}`);

  const { trendGroup } = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));
  const sourceVideo = trendGroup?.examples?.[0];

  // Manual direct-URL override (SOURCE_VIDEO_URL or ./video-link.txt); otherwise
  // resolve a fresh mp4 from the stable webVideoUrl via tikwm.
  const manualUrl =
    process.env.SOURCE_VIDEO_URL ||
    (await fs.readFile('./video-link.txt', 'utf-8').catch(() => '')).trim();
  if (!sourceVideo?.webVideoUrl && !manualUrl) {
    throw new Error(
      'No way to get the source clip: this script has no webVideoUrl to resolve, and no ' +
        'SOURCE_VIDEO_URL / video-link.txt override is set.'
    );
  }

  await fs.mkdir(WORK_DIR, { recursive: true });
  const sourcePath = path.join(WORK_DIR, 'source-video.mp4');
  const clipUrl = manualUrl || (await resolveClipUrl(sourceVideo.webVideoUrl));
  console.log(`Downloading clip${manualUrl ? ' from manual URL' : ` (resolved from ${sourceVideo.webVideoUrl})`}...`);
  await downloadTo(clipUrl, sourcePath);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${path.basename(scriptPath, '.json')}.mp4`);

  console.log('Applying color filter (keeping original audio)...');
  await execFileAsync(FFMPEG, [
    '-y',
    '-i', sourcePath,
    '-vf', COLOR_FILTER,
    '-c:a', 'copy', // original audio untouched
    outputPath,
  ]);

  console.log(`\nDone. Color-graded video with original audio saved to ${outputPath}`);
}

main().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
