import 'dotenv/config';
import cron from 'node-cron';
import { runGather } from './pipeline.js';
import { runAutopost } from './autopost.js';
import { config } from './config.js';

// Long-running entrypoint for the repost pipeline. Instead of an external
// EventBridge schedule firing a fresh Fargate task per tick, the cadence lives
// INSIDE this process (node-cron), so the whole thing runs as one always-on ECS
// task/service. Two independent schedules:
//   - GATHER  (default daily): resolve -> discover -> download -> re-clip ->
//             queue the top N new videos, spaced 3h apart. Also runs once on
//             startup so a fresh container fills its queue immediately.
//   - AUTOPOST (default every 30m): publish any queue entry whose slot is due,
//             guarded by autopost's live 3h-gap check. Polling finer than the 3h
//             gap avoids drift; the gap itself is the real cadence.
//
// All state (queue.json, posting-log.json, ready/*.mp4) lives on the mounted
// data dir (EFS in the deploy), so it survives container restarts.

const GATHER_CRON = process.env.REPOST_GATHER_CRON || '0 6 * * *'; // daily 06:00
const POST_CRON = process.env.REPOST_POST_CRON || '*/30 * * * *'; // every 30 min
const TIMEZONE = process.env.REPOST_TIMEZONE || 'UTC';
const GATHER_ON_START = (process.env.REPOST_GATHER_ON_START ?? 'true') === 'true';

for (const [name, expr] of [['REPOST_GATHER_CRON', GATHER_CRON], ['REPOST_POST_CRON', POST_CRON]]) {
  if (!cron.validate(expr)) {
    console.error(`Invalid ${name}: "${expr}"`);
    process.exit(1);
  }
}

// Guard each job against overlap: a gather run can take minutes, and we never
// want two gather (or two autopost) passes mutating the same state at once.
let gathering = false;
async function gather() {
  if (gathering) return console.log('[gather] previous run still going — skipping this tick.');
  gathering = true;
  console.log(`[${new Date().toISOString()}] [gather] starting...`);
  try {
    const { queued } = await runGather();
    console.log(`[gather] done — ${queued.length} clip(s) queued.`);
  } catch (err) {
    console.error(`[gather] failed: ${err.message}`);
  } finally {
    gathering = false;
  }
}

let posting = false;
async function post() {
  if (posting) return console.log('[autopost] previous run still going — skipping this tick.');
  posting = true;
  console.log(`[${new Date().toISOString()}] [autopost] checking for due clips...`);
  try {
    const { posted, held, remaining } = await runAutopost();
    console.log(`[autopost] posted ${posted}, held ${held} (gap/cap), ${remaining} still queued.`);
  } catch (err) {
    console.error(`[autopost] failed: ${err.message}`);
  } finally {
    posting = false;
  }
}

console.log('Repost scheduler started.');
console.log(`  gather cron:   "${GATHER_CRON}" (${TIMEZONE})${GATHER_ON_START ? ' + once on startup' : ''}`);
console.log(`  autopost cron: "${POST_CRON}" (${TIMEZONE})`);
console.log(`  target account: ${config.blotatoAccountId || '(unset — schedule only)'}`);
console.log(`  dry run: ${config.dryRun}`);

cron.schedule(GATHER_CRON, gather, { timezone: TIMEZONE });
cron.schedule(POST_CRON, post, { timezone: TIMEZONE });

// Fill the queue immediately on boot so a fresh container isn't idle until the
// first gather tick. Posting then drains it on the autopost cadence.
if (GATHER_ON_START) gather();
