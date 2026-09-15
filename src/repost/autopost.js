import { pathToFileURL } from 'url';
import path from 'path';
import { config } from './config.js';
import { readQueue, writeQueue, readLog, recordPost } from './postQueue.js';
import { getObject } from './storage.js';
import { uploadMedia, createTikTokPost } from './blotato.js';

// Stage 6: Auto-Posting.
// Walks the queue for entries whose scheduled time has arrived and publishes
// them to TikTok via Blotato — but only after a LIVE re-check of the 3h rule
// against the posting log. The queue's scheduled times already respect the gap,
// but a live re-check is the actual safety net: it holds even if the queue was
// hand-edited, two runs overlap, or a post landed out of band.

const HOUR = 3600 * 1000;

/** True if `account` posted within the last `minGapHours`, per the log. */
function withinGap(account, log, now) {
  const gap = config.minGapHours * HOUR;
  return log.some(
    (e) => e.accountId === String(account) && now - Date.parse(e.postedAt) < gap
  );
}

async function publishEntry(entry) {
  const filename = path.basename(entry.ready.key || 'clip.mp4');
  const bytes = await getObject(entry.ready);

  if (config.dryRun) {
    console.log(`  [dry-run] would post ${filename} to account ${entry.accountId}`);
    return { dryRun: true };
  }
  const mediaUrl = await uploadMedia(filename, bytes);
  // The trending sound rides as metadata (added in-app on publish), so the post
  // description is just the caption — no sound name jammed into it.
  return createTikTokPost({ accountId: entry.accountId, mediaUrl, caption: entry.caption });
}

/**
 * Publish all due queue entries, respecting the 3h gap per account. At most one
 * post per account per invocation — the rest stay queued for a later run once
 * their gap clears.
 */
export async function runAutopost({ force = false } = {}) {
  if (!config.blotatoAccountId && !config.dryRun) {
    throw new Error('Missing REPOST_BLOTATO_ACCOUNT_ID (or BLOTATO_TIKTOK_ACCOUNT_ID) in .env.');
  }
  const now = Date.now();
  const queue = await readQueue();
  let log = await readLog();

  const postedAccountsThisRun = new Set();
  let posted = 0;
  let held = 0;

  for (const entry of queue) {
    if (entry.status !== 'queued') continue;
    const due = force || Date.parse(entry.scheduledTime) <= now;
    if (!due) continue;

    // Never post twice for one account in a single run, and never inside the gap.
    if (postedAccountsThisRun.has(entry.accountId) || withinGap(entry.accountId, log, Date.now())) {
      held += 1;
      continue;
    }

    try {
      console.log(`Posting queued clip from @${entry.sourceAccount} to account ${entry.accountId}...`);
      await publishEntry(entry);
      entry.status = config.dryRun ? 'queued' : 'posted';
      entry.postedAt = new Date().toISOString();
      if (!config.dryRun) {
        log = await recordPost(entry.accountId, entry.postedAt);
        postedAccountsThisRun.add(entry.accountId);
      }
      posted += 1;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      entry.status = 'failed';
      entry.error = err.message;
    }
  }

  await writeQueue(queue);
  return { posted, held, remaining: queue.filter((e) => e.status === 'queued').length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  runAutopost({ force })
    .then(({ posted, held, remaining }) => {
      console.log(`\nDone. Posted ${posted}, held ${held} (gap/cap), ${remaining} still queued.`);
    })
    .catch((err) => {
      console.error('Auto-post failed:', err.message);
      process.exit(1);
    });
}
