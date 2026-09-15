import { pathToFileURL } from 'url';
import { config } from './config.js';
import { resolveAccounts } from './resolveAccounts.js';
import { runScraper, extractVideo } from './apifyClient.js';

// Stage 2: Video & Sound Discovery.
// For each resolved account: scan its recent video history, rank by view count,
// keep the top performers, and tag each with the sound it used. The output is
// the shortlist that Stage 3 downloads.

/**
 * Scrape one account's recent videos and return its top performers by plays.
 */
async function topVideosForAccount(handle) {
  const items = await runScraper({
    profiles: [handle],
    resultsPerPage: config.videosPerAccount,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  return items
    .map(extractVideo)
    // Only videos we can actually act on later, above the floor for "proven".
    .filter((v) => v.webVideoUrl && v.plays >= config.minPlayCount)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, config.topVideosPerAccount)
    .map((v) => ({ ...v, sourceAccount: handle }));
}

/**
 * Run Stage 1 + 2 together (or Stage 2 alone if handles are passed) and return
 * a flat shortlist of high-performing videos, each tagged with its sound and
 * source account.
 * @param {{accounts?, hashtags?, names?, handles?: string[]}} input
 */
export async function discoverVideos(input = {}) {
  const handles = input.handles ?? (await resolveAccounts(input)).handles;
  if (handles.length === 0) return { shortlist: [], handles };

  const shortlist = [];
  for (const handle of handles) {
    console.log(`  scanning @${handle} (top ${config.topVideosPerAccount} of last ${config.videosPerAccount})...`);
    try {
      const top = await topVideosForAccount(handle);
      shortlist.push(...top);
      console.log(`    kept ${top.length} video(s).`);
    } catch (err) {
      // One bad/private account shouldn't sink the whole batch.
      console.error(`    skipped @${handle}: ${err.message}`);
    }
  }

  // Highest-view first across all accounts, so downstream caps (posts/day) spend
  // themselves on the strongest source material regardless of which account.
  shortlist.sort((a, b) => b.plays - a.plays);
  return { shortlist, handles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  discoverVideos()
    .then(({ shortlist }) => {
      console.log(`\nShortlisted ${shortlist.length} video(s):`);
      shortlist.forEach((v, i) => {
        console.log(
          `${i + 1}. @${v.sourceAccount} — ${v.plays.toLocaleString()} plays — sound: ${v.sound.name || 'unknown'}`
        );
        console.log(`   ${v.webVideoUrl}`);
      });
    })
    .catch((err) => {
      console.error('Video discovery failed:', err.message);
      process.exit(1);
    });
}
