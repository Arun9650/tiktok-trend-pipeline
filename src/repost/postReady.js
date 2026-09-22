import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { config } from './config.js';
import { readQueue, writeQueue, recordPost } from './postQueue.js';
import { getObject } from './storage.js';
import { uploadMedia, createTikTokPost } from './blotato.js';

// Post the newest ready clip NOW.
// Unlike autopost.js (which walks the queue on schedule and enforces the 3h
// gap), this is the "just push the freshly-edited video out" button: it finds
// the most-recently-produced *-edited.mp4, matches it to its queue entry for the
// caption/account, publishes immediately via Blotato, and records the post so
// the gap log stays consistent. Use --dry-run (or REPOST_DRY_RUN=true) to
// rehearse without hitting Blotato.

/**
 * Newest ready clip on disk. Recurses the local ready dir for *-edited.mp4 and
 * returns the one with the latest mtime, as { key, path }. (Local storage only;
 * with S3 configured, pass a queue-entry lookup instead.)
 */
async function newestReadyFile(dir) {
  let best = null;
  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.name.endsWith('-edited.mp4')) {
        const { mtimeMs } = await fs.stat(full);
        if (!best || mtimeMs > best.mtimeMs) {
          best = { path: full, mtimeMs, key: path.relative(dir, full).replace(/\\/g, '/') };
        }
      }
    }
  }
  await walk(dir);
  return best;
}

/** Match a ready file to its queue entry by key (or by basename as a fallback). */
function findQueueEntry(queue, file) {
  const base = path.basename(file.key);
  return (
    queue.find((e) => e.ready?.key && e.ready.key.replace(/\\/g, '/') === file.key) ||
    queue.find((e) => e.ready?.key && path.basename(e.ready.key) === base) ||
    null
  );
}

export async function postNewestReady() {
  if (!config.blotatoAccountId && !config.dryRun) {
    throw new Error('Missing REPOST_BLOTATO_ACCOUNT_ID (or BLOTATO_TIKTOK_ACCOUNT_ID) in .env.');
  }

  const file = await newestReadyFile(config.localReadyDir);
  if (!file) throw new Error(`No *-edited.mp4 found under ${config.localReadyDir}.`);

  const queue = await readQueue();
  const entry = findQueueEntry(queue, file);
  if (!entry) {
    console.warn(
      `  note: no queue entry matched ${file.key}; posting with an empty caption ` +
        `and account ${config.blotatoAccountId}.`
    );
  }

  const accountId = entry?.accountId || config.blotatoAccountId;
  const caption = entry?.caption || '';
  const location = entry?.ready || { backend: 'local', key: file.key, path: file.path };

  console.log(`Newest ready clip: ${file.key}`);
  console.log(`  account ${accountId}  caption: "${caption}"`);

  const bytes = await getObject(location);

  if (config.dryRun) {
    console.log(`  [dry-run] would upload ${path.basename(file.key)} (${bytes.length} bytes) and post now.`);
    return { dryRun: true, key: file.key };
  }

  const mediaUrl = await uploadMedia(path.basename(file.key), bytes);
  const res = await createTikTokPost({ accountId, mediaUrl, caption });

  const nowISO = new Date().toISOString();
  if (entry) {
    entry.status = 'posted';
    entry.postedAt = nowISO;
    await writeQueue(queue);
  }
  await recordPost(accountId, nowISO);

  console.log(`  posted ${file.key} to account ${accountId}.`);
  return { posted: true, key: file.key, response: res };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  postNewestReady()
    .then((r) => console.log(r.dryRun ? '\nDry run complete.' : '\nDone.'))
    .catch((err) => {
      console.error('Post-ready failed:', err.message);
      process.exit(1);
    });
}
