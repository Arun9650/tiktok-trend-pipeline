import 'dotenv/config';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID;
// Point this at a dataset JSON file you already exported from Apify to skip
// hitting the API entirely, e.g. LOCAL_DATASET_PATH=./dataset_tiktok-scraper_2026-08-12.json
const LOCAL_DATASET_PATH = process.env.LOCAL_DATASET_PATH;
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'clockworks~tiktok-scraper';
const HASHTAGS = (process.env.TIKTOK_HASHTAGS || 'stockmarket,daytrading,forex')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const MIN_SHARE_RATIO = Number(process.env.MIN_SHARE_RATIO || 0.005);
const MIN_PLAY_COUNT = Number(process.env.MIN_PLAY_COUNT || 5000);
const TOP_N_TRENDS = Number(process.env.TOP_N_TRENDS || 8);

// Keywords that suggest the video is actually about trading/markets,
// not just riding a broad hashtag like #fyp.
const TRADING_KEYWORDS = [
  'trad', 'invest', 'stock', 'forex', 'market', 'crypto', 'liquidity',
  'chart', 'candle', 'bull', 'bear', 'portfolio', 'equity', 'fx', 'pip',
];

/**
 * Kick off a fresh Apify actor run for the given hashtags and wait for it
 * to finish. Use this if you don't already have a dataset ID.
 */
async function runActor() {
  if (!APIFY_TOKEN) throw new Error('Missing APIFY_TOKEN in .env');

  const input = {
    hashtags: HASHTAGS,
    resultsPerPage: 100,
    shouldDownloadCovers: false,
    // Needed so renderVideo.js can re-edit the actual clip (filter + new
    // audio) instead of just generating text-over-background from the script.
    shouldDownloadVideos: true,
  };

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );
  if (!startRes.ok) {
    throw new Error(`Apify run start failed: ${startRes.status} ${await startRes.text()}`);
  }
  const { data: run } = await startRes.json();

  // Poll until the run finishes. Trend scrapes usually take 1-3 minutes.
  let status = run.status;
  let runId = run.id;
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const pollData = await pollRes.json();
    status = pollData.data.status;
    if (status === 'SUCCEEDED') return pollData.data.defaultDatasetId;
    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Apify run ended with status ${status}`);
    }
  }
  return run.defaultDatasetId;
}

/**
 * Pull items from a known dataset ID.
 */
async function fetchDataset(datasetId) {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`
  );
  if (!res.ok) {
    throw new Error(`Apify dataset fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Score a video by share-to-play ratio, which tracks "worth passing along"
 * better than raw play count does.
 */
function scoreVideo(item) {
  const plays = item.playCount ?? item.videoMeta?.playCount ?? 0;
  const shares = item.shareCount ?? item.videoMeta?.shareCount ?? 0;
  const text = (item.text ?? '').toLowerCase();

  const isTradingRelated = TRADING_KEYWORDS.some((kw) => text.includes(kw));
  const shareRatio = plays > 0 ? shares / plays : 0;

  return { plays, shares, shareRatio, isTradingRelated, text };
}

/**
 * Filter and rank raw scraper output down to the trends worth building
 * content around.
 */
function filterAndRank(items) {
  return items
    .map((item) => {
      const { plays, shares, shareRatio, isTradingRelated, text } = scoreVideo(item);
      return {
        text,
        plays,
        shares,
        shareRatio,
        isTradingRelated,
        soundName: item.musicMeta?.musicName ?? item.musicMeta?.musicOriginal ?? null,
        soundId: item.musicMeta?.musicId ?? null,
        authorName: item.authorMeta?.name ?? null,
        webVideoUrl: item.webVideoUrl ?? null,
        durationSec: item.videoMeta?.duration ?? null,
        // Direct file URL for the downloaded clip (shouldDownloadVideos above).
        // clockworks/tiktok-scraper's exact field name for this isn't
        // documented, so this tries the likely candidates defensively, same
        // as normalizeCreator() does in fetchCreators.js. If renderVideo.js
        // errors with "no source video URL", log one raw `item` here and
        // adjust this line to match, it's a one-line fix.
        videoDownloadUrl:
          item.videoMeta?.downloadAddr ??
          item.videoMeta?.originalDownloadAddr ??
          item.mediaUrls?.[0] ??
          null,
      };
    })
    .filter(
      (v) =>
        v.isTradingRelated &&
        v.plays >= MIN_PLAY_COUNT &&
        v.shareRatio >= MIN_SHARE_RATIO
    )
    .sort((a, b) => b.shareRatio - a.shareRatio)
    .slice(0, TOP_N_TRENDS);
}

/**
 * Group ranked videos by sound so you can see which audio is doing the
 * most work across multiple high-performing videos, not just one outlier.
 */
function groupBySound(ranked) {
  const bySound = new Map();
  for (const v of ranked) {
    const key = v.soundId || v.soundName || 'unknown';
    if (!bySound.has(key)) {
      bySound.set(key, { soundName: v.soundName, soundId: v.soundId, examples: [] });
    }
    bySound.get(key).examples.push(v);
  }
  return [...bySound.values()].sort((a, b) => b.examples.length - a.examples.length);
}

export async function getTrends() {
  let raw;
  if (LOCAL_DATASET_PATH) {
    const fileContents = await fs.readFile(LOCAL_DATASET_PATH, 'utf-8');
    raw = JSON.parse(fileContents);
  } else {
    const datasetId = APIFY_DATASET_ID || (await runActor());
    raw = await fetchDataset(datasetId);
  }
  const ranked = filterAndRank(raw);
  const soundGroups = groupBySound(ranked);
  return { ranked, soundGroups, rawCount: raw.length };
}

const REPORT_DIR = './trend-reports';

/**
 * Plain-text digest of a getTrends() result, short enough to drop straight
 * into a Telegram message or a terminal.
 */
export function formatSummary({ ranked, soundGroups, rawCount }) {
  const lines = [
    `Fetched ${rawCount} raw videos, ${ranked.length} passed the fx/trading + engagement filter.`,
    '',
  ];
  ranked.forEach((v, i) => {
    lines.push(
      `${i + 1}. [${(v.shareRatio * 100).toFixed(2)}% share, ${v.plays.toLocaleString()} plays] ${v.text.slice(0, 100)}`
    );
    if (v.webVideoUrl) lines.push(`   ${v.webVideoUrl}`);
  });
  if (ranked.length === 0) {
    lines.push('Nothing cleared the bar this run. Try lowering MIN_SHARE_RATIO/MIN_PLAY_COUNT or widening TIKTOK_HASHTAGS.');
  }
  lines.push('', `Sounds in play: ${soundGroups.length}`);
  return lines.join('\n');
}

/**
 * Write the filtered result to a timestamped JSON file under ./trend-reports
 * so each run (manual or scheduled) leaves an artifact behind instead of
 * just console output that scrolls away.
 */
export async function saveTrendReport(result) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const filePath = `${REPORT_DIR}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await fs.writeFile(filePath, JSON.stringify(result, null, 2));
  return { path: filePath, summary: formatSummary(result) };
}

// Allow running this file standalone for a quick check:
// node src/fetchTrends.js
// Uses pathToFileURL rather than a plain string template because on Windows
// process.argv[1] uses backslashes while import.meta.url always uses
// forward slashes — a plain comparison silently never matches there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  getTrends()
    .then(async (result) => {
      console.log(formatSummary(result));
      const { path: reportPath } = await saveTrendReport(result);
      console.log(`\nSaved filtered results to ${reportPath}`);
    })
    .catch((err) => {
      console.error('Failed to fetch trends:', err.message);
      process.exit(1);
    });
}