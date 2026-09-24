import path from 'path';
import fs from 'fs/promises';
import { config } from './config.js';

// Stage 5 (part 2) + shared state for Stage 6: the posting queue and the
// posting log that together enforce the PRD's hard rule — at most one post per
// account per 3 hours. Both are plain JSON files so state survives restarts and
// is easy to inspect/reset by hand.

// Where the queue/log/processed JSON lives. Configurable so a serverless/EFS
// deploy can point all state at a persistent mount (e.g. /mnt/repost-data)
// shared across separate gather and posting task runs.
const DATA_DIR = config.dataDir;
const QUEUE_PATH = path.join(DATA_DIR, 'queue.json');
const LOG_PATH = path.join(DATA_DIR, 'posting-log.json');
// Source video keys we've already turned into a post (or tried to), so no
// source is ever reposted twice — a repeated gather run picks the next-best
// NEW video instead of re-queuing the same top performer.
const PROCESSED_PATH = path.join(DATA_DIR, 'processed-sources.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export const readQueue = () => readJson(QUEUE_PATH, []);
export const writeQueue = (q) => writeJson(QUEUE_PATH, q);
export const readLog = () => readJson(LOG_PATH, []);

/** The set of source-video keys already processed in a prior (or this) run. */
export async function readProcessed() {
  return new Set(await readJson(PROCESSED_PATH, []));
}

/** Mark source-video keys as processed so they're never picked again. */
export async function markProcessed(keys) {
  const set = await readProcessed();
  for (const k of keys) if (k) set.add(String(k));
  await writeJson(PROCESSED_PATH, [...set]);
  return set;
}

// Record an actual post (or a firmly scheduled one) against an account so the
// 3h gap is enforced across separate process runs, not just within one batch.
export async function recordPost(accountId, whenISO = new Date().toISOString()) {
  const log = await readLog();
  log.push({ accountId: String(accountId), postedAt: whenISO });
  await writeJson(LOG_PATH, log);
  return log;
}

const HOUR = 3600 * 1000;

/**
 * How many posts an account already has within the 24h ending at `at`.
 * Considers both the posting log and already-scheduled queue entries.
 */
function postsInDay(times, at) {
  const dayAgo = at - 24 * HOUR;
  return times.filter((t) => t > dayAgo && t <= at).length;
}

/**
 * Compute the earliest allowed post time for `account`, given the times it's
 * already been posted/scheduled for. Enforces the 3h minimum gap and the
 * per-day cap, walking forward until a legal slot is found.
 */
export function nextSlot(account, existingTimes, from = Date.now()) {
  const times = [...existingTimes].sort((a, b) => a - b);
  const gap = config.minGapHours * HOUR;

  // Earliest candidate: 3h after the most recent existing time, or now.
  let candidate = Math.max(from, times.length ? times[times.length - 1] + gap : from);

  // Respect the daily cap: if the rolling 24h window at `candidate` is already
  // full, push to just after the oldest in-window post frees a slot.
  // Bounded loop so a misconfiguration can't spin forever.
  for (let i = 0; i < 50; i++) {
    if (postsInDay(times, candidate) < config.maxPostsPerDay) break;
    const inWindow = times.filter((t) => t > candidate - 24 * HOUR && t <= candidate).sort((a, b) => a - b);
    candidate = inWindow[0] + 24 * HOUR + 1;
  }
  return candidate;
}

/**
 * Assign scheduled times to a batch of videos for one account and append them
 * to the queue. Later videos stack 3h apart after earlier ones in the batch.
 */
export async function scheduleVideos(videos, accountId) {
  const [queue, log] = await Promise.all([readQueue(), readLog()]);
  const account = String(accountId);

  // Seed with times already committed for this account (queued + posted).
  const committed = [
    ...log.filter((e) => e.accountId === account).map((e) => Date.parse(e.postedAt)),
    ...queue.filter((e) => e.accountId === account).map((e) => Date.parse(e.scheduledTime)),
  ].filter((n) => !Number.isNaN(n));

  const added = [];
  for (const v of videos) {
    const when = nextSlot(account, committed, Date.now());
    committed.push(when); // so the next video in the batch lands 3h later
    const entry = {
      id: `${account}-${v.id || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      accountId: account,
      scheduledTime: new Date(when).toISOString(),
      status: 'queued',
      caption: v.caption,
      ready: v.ready,
      trendingSound: v.trendingSound || null,
      sourceAccount: v.sourceAccount,
      sourceUrl: v.webVideoUrl,
    };
    queue.push(entry);
    added.push(entry);
  }
  await writeQueue(queue);
  return added;
}
