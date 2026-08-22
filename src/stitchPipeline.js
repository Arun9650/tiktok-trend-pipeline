import { getTrends } from './fetchTrends.js';
import { generateStitchScript } from './generateStitchScript.js';
import { requestStitchApproval } from './telegramReview.js';
import fs from 'fs/promises';
import { pathToFileURL } from 'url';

const APPROVED_DIR = './approved-stitches';
const TOP_N_STITCH_CANDIDATES = Number(process.env.TOP_N_STITCH_CANDIDATES || 5);

export async function runStitchPipeline() {
  console.log(`[${new Date().toISOString()}] Finding Stitch/Duet candidates...`);
  const { ranked, rawCount } = await getTrends();
  console.log(`Kept ${ranked.length} of ${rawCount} scraped videos after filtering.`);

  const candidates = ranked.slice(0, TOP_N_STITCH_CANDIDATES);
  if (candidates.length === 0) {
    console.log('No candidates cleared the filter thresholds. Try loosening MIN_SHARE_RATIO or MIN_PLAY_COUNT in .env.');
    return { approved: 0, rejected: 0, failed: 0 };
  }

  await fs.mkdir(APPROVED_DIR, { recursive: true });

  let approved = 0, rejected = 0, failed = 0;

  for (const video of candidates) {
    console.log(`\nGenerating reaction script for: "${video.text.slice(0, 60)}..."`);

    let script;
    try {
      script = await generateStitchScript(video);
    } catch (err) {
      console.error(`Stitch script generation failed: ${err.message}`);
      failed++;
      continue;
    }

    console.log('Sending to Telegram for approval...');
    const wasApproved = await requestStitchApproval(script, video);

    if (wasApproved) {
      const filename = `${APPROVED_DIR}/${Date.now()}-stitch.json`;
      await fs.writeFile(filename, JSON.stringify({ script, sourceVideo: video }, null, 2));
      console.log(`Saved to ${filename}. Open the source video link in TikTok, tap Stitch/Duet, and read the reaction script while recording.`);
      approved++;
    } else {
      rejected++;
    }
  }

  console.log(`\n[${new Date().toISOString()}] Stitch pipeline run complete. Approved: ${approved}, Rejected: ${rejected}, Failed: ${failed}`);
  return { approved, rejected, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStitchPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Stitch pipeline failed:', err);
      process.exit(1);
    });
}
