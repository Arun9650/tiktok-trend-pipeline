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
    shouldDownloadVideos: false,
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

// Allow running this file standalone for a quick check:
// node src/fetchTrends.js
// Uses pathToFileURL rather than a plain string template because on Windows
// process.argv[1] uses backslashes while import.meta.url always uses
// forward slashes — a plain comparison silently never matches there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  getTrends()
    .then(({ ranked, soundGroups, rawCount }) => {
      console.log(`Fetched ${rawCount} raw items, kept ${ranked.length} after filtering.\n`);
      console.log('Top trends:');
      ranked.forEach((v, i) => {
        console.log(
          `${i + 1}. [${(v.shareRatio * 100).toFixed(2)}% share rate] ${v.text.slice(0, 80)}`
        );
      });
      console.log('\nSounds in play:');
      soundGroups.forEach((s) => console.log(`- ${s.soundName || 'Unknown'} (${s.examples.length} videos)`));
    })
    .catch((err) => {
      console.error('Failed to fetch trends:', err.message);
      process.exit(1);
    });
}