import 'dotenv/config';
import cron from 'node-cron';
import { runAutopost } from './autopost.js';

// Stage 6 on a timer. The posting queue holds clips with scheduled times spaced
// 3h apart per account; this just wakes up periodically and posts whatever has
// come due (runAutopost re-checks the 3h gap live before each post). Default:
// every 30 minutes, which is well under the 3h cadence so no slot is missed by
// much, while never risking an early post because the gap check is the real
// gate — not this tick interval.
const SCHEDULE = process.env.REPOST_POST_CRON || '*/30 * * * *';
const TIMEZONE = process.env.PIPELINE_TIMEZONE || 'Asia/Kolkata';

async function tick() {
  console.log(`[${new Date().toISOString()}] Checking repost queue for due posts...`);
  try {
    const { posted, held, remaining } = await runAutopost();
    console.log(`  posted ${posted}, held ${held} (gap/cap), ${remaining} still queued.`);
  } catch (err) {
    console.error('  autopost tick failed:', err.message);
  }
}

if (!cron.validate(SCHEDULE)) {
  console.error(`Invalid REPOST_POST_CRON: "${SCHEDULE}"`);
  process.exit(1);
}

console.log(`Repost poster started. Cron: "${SCHEDULE}" (${TIMEZONE}). Enforcing 3h min gap per account.`);
cron.schedule(SCHEDULE, tick, { timezone: TIMEZONE });
tick();
