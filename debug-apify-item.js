import 'dotenv/config';
import fs from 'fs/promises';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID;

async function main() {
  if (!APIFY_TOKEN) throw new Error('Missing APIFY_TOKEN in .env');
  if (!APIFY_DATASET_ID) {
    console.error('Set APIFY_DATASET_ID in .env first.');
    process.exit(1);
  }

  const res = await fetch(
    `https://api.apify.com/v2/datasets/${APIFY_DATASET_ID}/items?token=${APIFY_TOKEN}&clean=true&limit=1`
  );
  const [item] = await res.json();

  const link = item.videoMeta?.subtitleLinks?.[0]?.downloadLink;
  if (!link) {
    console.error('No subtitleLinks[0].downloadLink on this item.');
    return;
  }
  await fs.writeFile('./video-link.txt', link);
  console.log('Wrote full URL to ./video-link.txt');
}

main();