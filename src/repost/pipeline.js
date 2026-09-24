import { pathToFileURL } from 'url';
import { config, sourceKey } from './config.js';
import { storageInfo } from './storage.js';
import { discoverVideos } from './discoverVideos.js';
import { downloadShortlist } from './download.js';
import { reclipAll } from './reclip.js';
import { getTrendingSounds, attachSounds } from './trendingSounds.js';
import { requestRepostApproval } from './review.js';
import { scheduleVideos, readProcessed, markProcessed } from './postQueue.js';

// Orchestrator for Stages 1-5 of the repost pipeline: resolve accounts ->
// discover top videos -> download to raw -> re-clip + caption to ready ->
// match a trending sound -> (optional approval) -> schedule into the posting
// queue with the 3h gap enforced. Stage 6 (actual posting) is deliberately a
// separate process (autopost.js / the scheduler) so posting cadence is driven
// by wall-clock time, not by when a gather run happens to finish.
//
// @param {{accounts?, hashtags?, names?, handles?}} input
export async function runGather(input = {}) {
  const store = storageInfo();
  console.log(`Repost pipeline starting.`);
  console.log(`  raw storage:   ${store.raw}`);
  console.log(`  ready storage: ${store.ready}`);
  console.log(`  target account: ${config.blotatoAccountId || '(unset — schedule only)'}`);

  console.log('\n[1-2] Resolving accounts and discovering top videos...');
  const { shortlist, handles } = await discoverVideos(input);
  console.log(`  ${handles.length} account(s) scanned, ${shortlist.length} video(s) shortlisted.`);
  if (shortlist.length === 0) return { queued: [], handles, shortlist };

  // Uniqueness across runs: drop any source we've already turned into a post so
  // the same clip is never reposted twice. Dedup within this batch too.
  const processed = await readProcessed();
  const seenThisRun = new Set();
  const seenAccounts = new Set();
  // shortlist is sorted best-first (by plays), so the first video we keep for an
  // account is that account's strongest. We keep at most one per account so the
  // batch of N is N *distinct* creators, not several clips from one account —
  // every posted video comes from a unique source account.
  const fresh = shortlist.filter((v) => {
    const k = sourceKey(v);
    if (!k || processed.has(k) || seenThisRun.has(k)) return false;
    const acct = (v.sourceAccount || '').toLowerCase();
    if (acct && seenAccounts.has(acct)) return false;
    seenThisRun.add(k);
    if (acct) seenAccounts.add(acct);
    return true;
  });
  const skipped = shortlist.length - fresh.length;
  if (fresh.length === 0) {
    console.log(`  all ${shortlist.length} discovered video(s) already processed — nothing new to post. Widen inputs or wait for new uploads.`);
    return { queued: [], handles, shortlist };
  }

  // One video at a time (default): the shortlist is already sorted best-first
  // across all accounts, so take the top N fresh ones and only download/edit
  // those. Keeps a run cheap and matches the 3h posting cadence.
  const selected = fresh.slice(0, config.maxOutputsPerRun);
  console.log(`  processing ${selected.length} of ${fresh.length} new (${skipped} already-processed skipped; REPOST_MAX_OUTPUTS_PER_RUN=${config.maxOutputsPerRun}).`);

  console.log('\n[3] Downloading to raw storage...');
  const downloaded = await downloadShortlist(selected);

  console.log('\n[4] Re-clipping + burning captions to ready storage...');
  const edited = await reclipAll(downloaded);
  // Mark sources processed once an edited clip exists (an expensive, committed
  // artifact). A failed earlier stage stays unmarked so it can be retried next
  // run; a produced clip is never made again.
  if (edited.length) await markProcessed(edited.map(sourceKey));

  console.log('\n[5] Matching trending sounds...');
  const sounds = await getTrendingSounds(shortlist);
  const withSound = attachSounds(edited, sounds);
  console.log(`  ${sounds.length} trending sound(s) available; attached best match to ${withSound.length} clip(s).`);

  console.log('\n[5] Review + scheduling...');
  const queued = [];
  for (const video of withSound) {
    const approved = await requestRepostApproval(video);
    if (!approved) {
      console.log(`  rejected: @${video.sourceAccount} — ${video.webVideoUrl}`);
      continue;
    }
    // The pilot posts to one account (PRD). Fall back to source handle only so a
    // missing target still produces an inspectable, correctly-spaced schedule.
    const target = config.blotatoAccountId || video.sourceAccount;
    const [entry] = await scheduleVideos([video], target);
    console.log(`  queued for ${entry.scheduledTime} (account ${entry.accountId})`);
    queued.push(entry);
  }

  console.log(`\nDone. ${queued.length} clip(s) queued. Run \`npm run repost:post\` (or the scheduler) to publish as each slot comes due.`);
  return { queued, handles, shortlist };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Convenience flags for a local dry run without editing .env:
  //   --dry-run       never publish (gather already doesn't post, but this also
  //                   makes any downstream posting a rehearsal)
  //   --auto-approve  skip the Telegram review gate
  //   --max=N         select the top N videos this run (e.g. --max=5)
  const args = process.argv.slice(2);
  if (args.includes('--dry-run')) config.dryRun = true;
  if (args.includes('--auto-approve')) config.requireApproval = false;
  const maxArg = args.find((a) => a.startsWith('--max='));
  if (maxArg) config.maxOutputsPerRun = Number(maxArg.slice('--max='.length)) || config.maxOutputsPerRun;

  runGather()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Repost pipeline failed:', err.message);
      process.exit(1);
    });
}
