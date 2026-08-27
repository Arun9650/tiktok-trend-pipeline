import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';

// Content Posting API, "Upload to Inbox" mode: the video lands in your TikTok
// app drafts/inbox, where you add the trending sound and hit publish. Works
// with an unaudited/sandbox app (scope: video.upload). Direct-post-to-profile
// needs an audited app; when you have that, swap the init URL to
// .../v2/post/publish/video/init/ and add a post_info block.
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const OUTPUT_DIR = './rendered-videos';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';

async function latestRenderedVideo() {
  const files = (await fs.readdir(OUTPUT_DIR)).filter((f) => f.endsWith('.mp4'));
  if (files.length === 0) throw new Error(`No .mp4 files in ${OUTPUT_DIR}. Run npm run render first.`);
  const withTime = await Promise.all(
    files.map(async (f) => ({ f, m: (await fs.stat(path.join(OUTPUT_DIR, f))).mtimeMs }))
  );
  withTime.sort((a, b) => b.m - a.m);
  return path.join(OUTPUT_DIR, withTime[0].f);
}

async function main() {
  if (!ACCESS_TOKEN) {
    throw new Error(
      'Missing TIKTOK_ACCESS_TOKEN in .env. Register an app at developers.tiktok.com, add the ' +
        'Content Posting API with the video.upload scope, run the OAuth flow, and paste the ' +
        'user access token here.'
    );
  }

  const videoPath = process.argv[2] || (await latestRenderedVideo());
  const bytes = await fs.readFile(videoPath);
  const videoSize = bytes.length;
  // Single chunk (our renders are well under TikTok's 64MB/chunk limit).
  console.log(`Uploading ${videoPath} (${(videoSize / 1e6).toFixed(1)}MB) to TikTok inbox...`);

  const initRes = await fetch(INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: videoSize,
        total_chunk_count: 1,
      },
    }),
  });
  const initJson = await initRes.json();
  if (!initRes.ok || initJson.error?.code !== 'ok') {
    throw new Error(`init failed: ${initRes.status} ${JSON.stringify(initJson.error || initJson)}`);
  }
  const { publish_id, upload_url } = initJson.data;

  const putRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoSize),
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
    },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`upload failed: ${putRes.status} ${await putRes.text()}`);
  }

  console.log(`\nDone. Video sent to your TikTok inbox (publish_id: ${publish_id}).`);
  console.log('Open the TikTok app > Inbox/Drafts, add the trending sound, then publish.');
}

main().catch((err) => {
  console.error('Upload failed:', err);
  process.exit(1);
});
