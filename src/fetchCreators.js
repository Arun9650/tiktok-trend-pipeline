import 'dotenv/config';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import { getTrends } from './fetchTrends.js';

// Creative Center's "video"/"creator" modes pull from TikTok's general
// Explore feed (globally viral content, any topic) with no way to filter by
// niche, only "hashtag" mode gets real topic targeting, and even that's just
// rankings, not authors. So instead of a second, weaker data source, this
// derives the target/watch list directly from the same hashtag-filtered
// trend data fetchTrends.js already pulls, which is actually finance-scoped.
//
// This is a target/watch list for engaging with (following, liking,
// commenting) to seed the algorithm toward the right audience. It is NOT a
// source list for reposting their content, that's a separate copyright
// problem regardless of who the creator is. See README for why.

export async function getTargetCreators() {
  const { ranked, rawCount } = await getTrends();

  const byAuthor = new Map();
  for (const v of ranked) {
    if (!v.authorName) continue;
    const existing = byAuthor.get(v.authorName);
    if (!existing || v.shareRatio > existing.shareRatio) {
      byAuthor.set(v.authorName, {
        handle: v.authorName,
        profileUrl: `https://www.tiktok.com/@${v.authorName}`,
        exampleVideoUrl: v.webVideoUrl,
        exampleCaption: v.text,
        shareRatio: v.shareRatio,
        plays: v.plays,
      });
    }
  }

  const relevant = [...byAuthor.values()].sort((a, b) => b.shareRatio - a.shareRatio);
  return { relevant, rawCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  getTargetCreators()
    .then(async ({ relevant, rawCount }) => {
      console.log(`Fetched ${rawCount} raw videos, ${relevant.length} distinct finance-related creators found.\n`);

      if (relevant.length === 0) {
        console.log('No creators found. Check TIKTOK_HASHTAGS and MIN_SHARE_RATIO/MIN_PLAY_COUNT in .env, same thresholds fetchTrends.js uses.');
        return;
      }

      relevant.forEach((c, i) => {
        console.log(`${i + 1}. @${c.handle} — ${(c.shareRatio * 100).toFixed(2)}% share rate, ${c.plays.toLocaleString()} plays`);
        console.log(`   ${c.profileUrl}`);
      });

      await fs.writeFile('./target-creators.json', JSON.stringify(relevant, null, 2));
      console.log('\nSaved to ./target-creators.json. This is a watch/engage list, not a repost source.');
    })
    .catch((err) => {
      console.error('Failed to fetch target creators:', err.message);
      process.exit(1);
    });
}