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

async function listApprovedScripts() {
  const files = await fs.readdir(APPROVED_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error(`No approved scripts found in ${APPROVED_DIR}. Run the pipeline and approve one via Telegram first.`);
  }
  // Filenames are timestamp-prefixed, so a plain sort renders oldest-first.
  jsonFiles.sort();
  return jsonFiles.map((f) => path.join(APPROVED_DIR, f));
}

// Render a single approved script to an mp4. `manualUrl` (if given) overrides
// the clip source; in batch mode it's left undefined so every script uses its
// own webVideoUrl. Returns the output path, or null if it was skipped.
async function renderOne(scriptPath, manualUrl) {
  const { trendGroup } = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));
  const sourceVideo = trendGroup?.examples?.[0];

  if (!sourceVideo?.webVideoUrl && !manualUrl) {
    throw new Error(
      'No way to get the source clip: this script has no webVideoUrl to resolve, and no ' +
        'SOURCE_VIDEO_URL / video-link.txt override is set.'
    );
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${path.basename(scriptPath, '.json')}.mp4`);

  // Skip anything already rendered so re-running the batch only fills gaps.
  // Set FORCE_RERENDER=true to overwrite existing outputs.
  if (process.env.FORCE_RERENDER !== 'true') {
    const alreadyDone = await fs
      .stat(outputPath)
      .then(() => true)
      .catch(() => false);
    if (alreadyDone) {
      console.log(`  skip (already rendered): ${path.basename(outputPath)}`);
      return null;
    }
  }

  await fs.mkdir(WORK_DIR, { recursive: true });
  const sourcePath = path.join(WORK_DIR, 'source-video.mp4');
  const clipUrl = manualUrl || (await resolveClipUrl(sourceVideo.webVideoUrl));
  console.log(`  downloading clip${manualUrl ? ' from manual URL' : ` (resolved from ${sourceVideo.webVideoUrl})`}...`);
  await downloadTo(clipUrl, sourcePath);

  console.log('  applying color filter (keeping original audio)...');
  await execFileAsync(FFMPEG, [
    '-y',
    '-i', sourcePath,
    '-vf', COLOR_FILTER,
    '-c:a', 'copy', // original audio untouched
    outputPath,
  ]);

  console.log(`  done -> ${outputPath}`);
  return outputPath;
}

async function main() {
  // Manual direct-URL override (SOURCE_VIDEO_URL or ./video-link.txt). This
  // only makes sense for a single script, so it's ignored in batch mode.
  const manualUrl =
    process.env.SOURCE_VIDEO_URL ||
    (await fs.readFile('./video-link.txt', 'utf-8').catch(() => '')).trim();

  // Explicit single-script mode: `node src/renderVideo.js path/to/script.json`.
  const explicitPath = process.argv[2];
  if (explicitPath) {
    console.log(`Rendering single script: ${explicitPath}`);
    await renderOne(explicitPath, manualUrl || undefined);
    return;
  }

  // Default: render every approved script — but dedupe by source clip first.
  // This renderer only color-grades the source clip (it doesn't burn in the
  // per-script text), so N scripts sharing one webVideoUrl would produce N
  // identical videos. Render each distinct clip exactly once.
  const scripts = await listApprovedScripts();

  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const scriptPath of scripts) {
    let url;
    try {
      const { trendGroup } = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));
      url = trendGroup?.examples?.[0]?.webVideoUrl;
    } catch {
      url = undefined;
    }
    // Scripts without a resolvable clip URL can't collide on one, so keep each
    // (renderOne will surface the real error for them).
    const key = url || `__no_url__:${scriptPath}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(scriptPath);
  }

  console.log(
    `Found ${scripts.length} approved script(s) -> ${unique.length} unique source clip(s) ` +
      `(${duplicates} duplicate script(s) skipped). Rendering...\n`
  );

  let rendered = 0;
  let skipped = 0;
  const failures = [];
  for (const [i, scriptPath] of unique.entries()) {
    console.log(`[${i + 1}/${unique.length}] ${path.basename(scriptPath)}`);
    try {
      const out = await renderOne(scriptPath); // no manualUrl: use each clip's own url
      if (out) rendered += 1;
      else skipped += 1;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push({ scriptPath, message: err.message });
    }
  }

  console.log(`\nBatch complete. Rendered ${rendered}, skipped ${skipped}, failed ${failures.length} (of ${unique.length} unique clips).`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${path.basename(f.scriptPath)}: ${f.message}`);
  }
}

main().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
