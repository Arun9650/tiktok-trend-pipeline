import 'dotenv/config';
import cron from 'node-cron';
import { getTrends, saveTrendReport } from './fetchTrends.js';
import { sendDigest } from './telegramReview.js';

const SCHEDULE = process.env.PIPELINE_CRON_SCHEDULE || '0 10,18 * * *';
const TIMEZONE = process.env.PIPELINE_TIMEZONE || 'Asia/Kolkata';

// Fetches from Apify, filters for fx/trading + engagement, writes a report
// to ./trend-reports, and pings Telegram with a summary if configured. This
// is the "get me the filtered videos" step running unattended — it does not
// generate scripts or touch Groq/render, that's still `npm start` on demand.
async function runOnce() {
  console.log(`[${new Date().toISOString()}] Running scheduled trend fetch...`);
  try {
    const result = await getTrends();
    const { path: reportPath, summary } = await saveTrendReport(result);
    console.log(summary);
    console.log(`Report saved to ${reportPath}`);
    await sendDigest(`Trend fetch complete.\n\n${summary}`);
  } catch (err) {
    console.error('Scheduled trend fetch failed:', err.message);
  }
}

if (!cron.validate(SCHEDULE)) {
  console.error(`Invalid PIPELINE_CRON_SCHEDULE: "${SCHEDULE}"`);
  process.exit(1);
}

console.log(`Trend scheduler started. Cron: "${SCHEDULE}" (${TIMEZONE}).`);
console.log('Each run writes a filtered report to ./trend-reports and, if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are set, sends you a summary there too.');

cron.schedule(SCHEDULE, runOnce, { timezone: TIMEZONE });

// Run once immediately on startup so you're not waiting for the first tick.
runOnce();
