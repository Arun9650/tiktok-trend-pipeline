import { getTrends } from './fetchTrends.js';
import { generateScript } from './generateScript.js';
import { requestApproval } from './telegramReview.js';
import fs from 'fs/promises';

const APPROVED_DIR = './approved-scripts';

async function main() {
  console.log('Fetching trend data from Apify...');
  const { ranked, soundGroups, rawCount } = await getTrends();
  console.log(`Kept ${ranked.length} of ${rawCount} scraped videos after filtering.`);

  if (soundGroups.length === 0) {
    console.log('No trends cleared the filter thresholds. Try lowering MIN_SHARE_RATIO or MIN_PLAY_COUNT in .env, or widen TIKTOK_HASHTAGS.');
    return;
  }

  await fs.mkdir(APPROVED_DIR, { recursive: true });

  // Work through the top sound groups one at a time so you're not flooded
  // with approval requests all at once.
  for (const group of soundGroups) {
    console.log(`\nGenerating script for sound: ${group.soundName || 'unknown'} (${group.examples.length} examples)`);

    let script;
    try {
      script = await generateScript(group);
    } catch (err) {
      console.error(`Script generation failed for this trend: ${err.message}`);
      continue;
    }

    console.log('Sending to Telegram for approval...');
    const approved = await requestApproval(script, group);

    if (approved) {
      const filename = `${APPROVED_DIR}/${Date.now()}-${(group.soundName || 'script').replace(/\W+/g, '-').slice(0, 40)}.json`;
      await fs.writeFile(filename, JSON.stringify({ script, trendGroup: group }, null, 2));
      console.log(`Saved approved script to ${filename}. This is the handoff point to the Remotion render step.`);
    }
  }

  console.log('\nDone with this run. Approved scripts are in ./approved-scripts, ready for video rendering.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
