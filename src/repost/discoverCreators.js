import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import { config, normalizeHandle } from './config.js';
import { runScraper, extractVideo } from './apifyClient.js';

// Pull popular finance creators from TikTok via Apify.
//
// Searches a set of finance hashtags/terms, collects the authors behind the
// matching videos, and ranks them by popularity — follower count first, then
// reach in this niche (summed plays across their matched videos). This is a
// discovery / watch list: a starting point for the accounts you might feed into
// the repost pipeline (Stage 1) or simply engage with. It does NOT itself
// repost anyone's content.

/**
 * @param {{ terms?: string[] }} [opts]
 * @returns {Promise<{handle,nick,fans,verified,profileUrl,videos,plays}[]>}
 */
export async function discoverFinanceCreators({ terms } = {}) {
  // Hashtags and plain phrases both work directly as TikTok search queries.
  const queries = terms ?? config.financeTerms;

  const items = await runScraper({
    searchQueries: queries,
    resultsPerPage: config.searchResultsPerTerm,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  const byHandle = new Map();
  for (const raw of items) {
    const v = extractVideo(raw);
    const handle = normalizeHandle(v.authorHandle);
    if (!handle) continue;
    const cur =
      byHandle.get(handle) ||
      { handle, nick: v.authorNick, fans: 0, verified: false, profileUrl: v.authorProfileUrl, videos: 0, plays: 0 };
    cur.videos += 1;
    cur.plays += v.plays || 0;
    // authorMeta.fans is a per-item snapshot of the same account; keep the max.
    cur.fans = Math.max(cur.fans, v.authorFans || 0);
    if (v.authorVerified) cur.verified = true;
    if (!cur.nick && v.authorNick) cur.nick = v.authorNick;
    byHandle.set(handle, cur);
  }

  return [...byHandle.values()]
    .sort((a, b) => b.fans - a.fans || b.plays - a.plays)
    .slice(0, config.maxCreators);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  discoverFinanceCreators()
    .then(async (creators) => {
      console.log(`Found ${creators.length} popular finance creator(s):\n`);
      creators.forEach((c, i) => {
        const fans = c.fans ? `${c.fans.toLocaleString()} followers` : 'followers n/a';
        console.log(`${i + 1}. @${c.handle}${c.verified ? ' ✓' : ''} — ${fans} — ${c.plays.toLocaleString()} plays (${c.videos} vids)`);
        console.log(`   ${c.profileUrl}`);
      });
      if (creators.length === 0) {
        console.log('None found. Check APIFY_TOKEN and REPOST_FINANCE_TERMS in .env.');
        return;
      }
      await fs.mkdir('./repost-data', { recursive: true });
      await fs.writeFile('./repost-data/finance-creators.json', JSON.stringify(creators, null, 2));
      console.log('\nSaved to ./repost-data/finance-creators.json (a watch/source shortlist, not an auto-repost list).');
    })
    .catch((err) => {
      console.error('Creator discovery failed:', err.message);
      process.exit(1);
    });
}
