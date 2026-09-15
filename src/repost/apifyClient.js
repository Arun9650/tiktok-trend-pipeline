import { config } from './config.js';

// Shared Apify helpers for the repost pipeline. The generation pipeline's
// fetchTrends.js has its own copy tuned for hashtag trend scraping; this one is
// generalized so Stage 1 (search/profiles) and Stage 2 (per-account history)
// can drive the same actor with different inputs. Kept separate on purpose so
// changing one pipeline's scrape behavior never surprises the other.

const BASE = 'https://api.apify.com/v2';

/**
 * Run the TikTok scraper actor with the given input and return the resulting
 * dataset items. Polls until the run finishes (scrapes are typically 1-3 min).
 */
export async function runScraper(input, actorId = config.scraperActorId) {
  if (!config.apifyToken) throw new Error('Missing APIFY_TOKEN in .env');

  const startRes = await fetch(
    `${BASE}/acts/${actorId}/runs?token=${config.apifyToken}`,
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

  let status = run.status;
  const runId = run.id;
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(`${BASE}/actor-runs/${runId}?token=${config.apifyToken}`);
    const pollData = await pollRes.json();
    status = pollData.data.status;
    if (status === 'SUCCEEDED') return fetchDataset(pollData.data.defaultDatasetId);
    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Apify run ended with status ${status}`);
    }
  }
  return fetchDataset(run.defaultDatasetId);
}

/** Pull cleaned items from a known dataset id. */
export async function fetchDataset(datasetId) {
  const res = await fetch(
    `${BASE}/datasets/${datasetId}/items?token=${config.apifyToken}&clean=true`
  );
  if (!res.ok) {
    throw new Error(`Apify dataset fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Field extraction is centralized here because clockworks/tiktok-scraper's exact
// field names aren't documented and shift between item shapes (profile vs
// hashtag vs search). fetchTrends.js already learned this the hard way, so we
// probe the likely candidates defensively in one place.
export function extractVideo(item) {
  return {
    id: item.id ?? null,
    text: item.text ?? '',
    authorHandle: item.authorMeta?.name ?? null,
    authorNick: item.authorMeta?.nickName ?? null,
    webVideoUrl: item.webVideoUrl ?? null,
    plays: item.playCount ?? item.videoMeta?.playCount ?? 0,
    shares: item.shareCount ?? 0,
    likes: item.diggCount ?? 0,
    comments: item.commentCount ?? 0,
    durationSec: item.videoMeta?.duration ?? null,
    createTimeISO: item.createTimeISO ?? null,
    sound: {
      id: item.musicMeta?.musicId ?? null,
      name: item.musicMeta?.musicName ?? null,
      author: item.musicMeta?.musicAuthor ?? null,
      isOriginal: item.musicMeta?.musicOriginal ?? null,
      playUrl: item.musicMeta?.playUrl ?? null,
    },
    // Direct download candidates; resolveClipUrl() in reclip.js is the reliable
    // fallback when these are expired/absent (TikTok CDN links die in hours).
    downloadUrl:
      item.videoMeta?.downloadAddr ??
      item.mediaUrls?.[0] ??
      null,
  };
}
