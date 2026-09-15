import { pathToFileURL } from 'url';
import { config, normalizeHandle } from './config.js';
import { runScraper, extractVideo } from './apifyClient.js';

// Stage 1: Account Resolution.
// Input: any mix of account handles, hashtags, and people's names.
// Output: a deduped list of TikTok account handles to scan in Stage 2.
//
//  - Handles pass through directly (just normalized).
//  - Hashtags and names are searched on TikTok; the authors of the matching
//    videos become candidate accounts. A name like "Ross Cameron" has no handle
//    of its own, so the only reliable way to turn it into accounts is to see
//    who posts content that matches it — which is exactly a search query.

/**
 * Search TikTok for a set of terms (hashtags or names) and return the distinct
 * author handles behind the matching videos, ranked by how much of the matched
 * content they own (a creator who owns several matches is a better bet than one
 * who happens to appear once).
 */
async function accountsFromSearch(terms, { label }) {
  if (terms.length === 0) return [];
  console.log(`  searching TikTok for ${terms.length} ${label}: ${terms.join(', ')}`);

  // "search" mode returns videos across the query; hashtag terms work as search
  // queries too, so a single search run covers both hashtags and names.
  const items = await runScraper({
    searchQueries: terms,
    resultsPerPage: config.searchResultsPerTerm,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  const byHandle = new Map();
  for (const raw of items) {
    const v = extractVideo(raw);
    const handle = normalizeHandle(v.authorHandle);
    if (!handle) continue;
    const cur = byHandle.get(handle) || { handle, matches: 0, plays: 0 };
    cur.matches += 1;
    cur.plays += v.plays;
    byHandle.set(handle, cur);
  }
  return [...byHandle.values()].sort(
    (a, b) => b.matches - a.matches || b.plays - a.plays
  );
}

/**
 * Resolve a mixed input object into a clean, deduped, capped list of handles.
 * @param {{accounts?: string[], hashtags?: string[], names?: string[]}} input
 */
export async function resolveAccounts(input = {}) {
  const accounts = (input.accounts ?? config.inputAccounts).map(normalizeHandle).filter(Boolean);
  const hashtags = input.hashtags ?? config.inputHashtags;
  const names = input.names ?? config.inputNames;

  // Direct handles are the highest-confidence source, so they seed the list
  // first and searched-in accounts only fill remaining slots.
  const ordered = [];
  const seen = new Set();
  const push = (handle, source) => {
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    ordered.push({ handle, source });
  };

  for (const h of accounts) push(h, 'direct');

  // Hashtags are prefixed with # in TikTok search; names are searched as-is.
  const hashtagAccounts = await accountsFromSearch(
    hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)),
    { label: 'hashtags' }
  );
  const nameAccounts = await accountsFromSearch(names, { label: 'names' });

  for (const a of [...hashtagAccounts, ...nameAccounts]) push(a.handle, 'search');

  const capped = ordered.slice(0, config.maxAccounts);
  return {
    handles: capped.map((a) => a.handle),
    detail: capped,
    droppedForCap: Math.max(0, ordered.length - capped.length),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resolveAccounts()
    .then(({ handles, detail, droppedForCap }) => {
      console.log(`\nResolved ${handles.length} account(s) (cap ${config.maxAccounts}, dropped ${droppedForCap}):`);
      for (const a of detail) console.log(`  @${a.handle}  (${a.source})`);
      if (handles.length === 0) {
        console.log('Nothing resolved. Set REPOST_ACCOUNTS / REPOST_HASHTAGS / REPOST_NAMES in .env or pass input.');
      }
    })
    .catch((err) => {
      console.error('Account resolution failed:', err.message);
      process.exit(1);
    });
}
