import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';

// Auto-posts a rendered video straight to TikTok through Blotato
// (https://help.blotato.com/api/start). Blotato holds the TikTok OAuth
// connection, so unlike the raw Content Posting API in uploadTikTok.js this can
// publish directly to the profile (no "audited app" hoops, no inbox step).
//
// Flow: upload the local mp4 to Blotato's media store -> get a public URL ->
// create a TikTok post pointing at that URL -> (optionally) poll until it's
// live. Requires BLOTATO_API_KEY and BLOTATO_TIKTOK_ACCOUNT_ID in .env.
//   list accounts: node src/postBlotato.js --accounts
//   post latest:   node src/postBlotato.js
//   post a file:   node src/postBlotato.js ./rendered-videos/foo.mp4

const API_KEY = process.env.BLOTATO_API_KEY;
const BASE_URL = 'https://backend.blotato.com/v2';
const OUTPUT_DIR = './rendered-videos';
const APPROVED_DIR = './approved-scripts';

// TikTok target defaults (Blotato requires all of these on every TikTok post).
// Override per-account via .env. Note: brand-new / unaudited TikTok connections
// are sometimes restricted to SELF_ONLY (private) until reviewed — set
// BLOTATO_TIKTOK_PRIVACY=SELF_ONLY if PUBLIC_TO_EVERYONE gets rejected.
const TIKTOK_DEFAULTS = {
  privacyLevel: process.env.BLOTATO_TIKTOK_PRIVACY || 'PUBLIC_TO_EVERYONE',
  disabledComments: process.env.BLOTATO_TIKTOK_DISABLE_COMMENTS === 'true',
  disabledDuet: process.env.BLOTATO_TIKTOK_DISABLE_DUET === 'true',
  disabledStitch: process.env.BLOTATO_TIKTOK_DISABLE_STITCH === 'true',
  isBrandedContent: process.env.BLOTATO_TIKTOK_BRANDED_CONTENT === 'true',
  isYourBrand: process.env.BLOTATO_TIKTOK_YOUR_BRAND === 'true',
  // Disclose AI involvement by default — our scripts are LLM-generated.
  isAiGenerated: process.env.BLOTATO_TIKTOK_AI_GENERATED !== 'false',
};

// Thin wrapper: attaches the API key header, parses JSON, and turns non-2xx
// responses into readable errors instead of silent undefined data.
async function blotato(endpoint, { method = 'GET', body } = {}) {
  if (!API_KEY) {
    throw new Error(
      'Missing BLOTATO_API_KEY in .env. Grab it from Blotato > Settings > API ' +
        '(https://help.blotato.com/api/start).'
    );
  }
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'blotato-api-key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Blotato ${method} ${endpoint} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// GET /users/me/accounts -> the connected social accounts. You need the TikTok
// account's `id` (its accountId) for BLOTATO_TIKTOK_ACCOUNT_ID.
async function listAccounts() {
  const { items = [] } = await blotato('/users/me/accounts');
  return items;
}

// Upload a local file to Blotato's media store via the presigned-URL flow, then
// return the permanent public URL to reference when creating the post.
async function uploadLocalFile(videoPath) {
  const filename = path.basename(videoPath);
  const bytes = await fs.readFile(videoPath);

  const { presignedUrl, publicUrl } = await blotato('/media/uploads', {
    method: 'POST',
    body: { filename },
  });
  if (!presignedUrl || !publicUrl) {
    throw new Error(`Unexpected /media/uploads response (no presignedUrl/publicUrl).`);
  }

  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`Presigned upload failed (${put.status}): ${await put.text()}`);
  }
  return publicUrl;
}

// POST /posts — publish (or schedule) the video to TikTok. `scheduledTime`
// (ISO string) is a sibling of `post`, never nested inside it.
async function createTikTokPost({ accountId, mediaUrl, caption, scheduledTime }) {
  const payload = {
    post: {
      accountId: String(accountId),
      content: {
        text: caption,
        mediaUrls: [mediaUrl],
        platform: 'tiktok',
      },
      target: { targetType: 'tiktok', ...TIKTOK_DEFAULTS },
    },
    ...(scheduledTime ? { scheduledTime } : {}),
  };
  return blotato('/posts', { method: 'POST', body: payload });
}

// Poll GET /posts/{id} until the submission is published or failed (or we give
// up). Best-effort: Blotato accepted the job either way, this is just for logs.
async function pollStatus(postSubmissionId, { tries = 20, intervalMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await blotato(`/posts/${postSubmissionId}`).catch(() => null);
    const status = res?.status;
    if (status === 'published' || status === 'failed') return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function latestRenderedVideo() {
  const files = (await fs.readdir(OUTPUT_DIR)).filter((f) => f.endsWith('.mp4'));
  if (files.length === 0) throw new Error(`No .mp4 files in ${OUTPUT_DIR}. Run npm run render first.`);
  const withTime = await Promise.all(
    files.map(async (f) => ({ f, m: (await fs.stat(path.join(OUTPUT_DIR, f))).mtimeMs }))
  );
  withTime.sort((a, b) => b.m - a.m);
  return path.join(OUTPUT_DIR, withTime[0].f);
}

// Rendered videos are named <scriptBasename>.mp4, so we can recover the caption
// the LLM already wrote for this clip. Falls back to the hook, then env, then ''.
async function captionFor(videoPath) {
  const scriptPath = path.join(APPROVED_DIR, `${path.basename(videoPath, '.mp4')}.json`);
  try {
    const { script } = JSON.parse(await fs.readFile(scriptPath, 'utf-8'));
    if (script?.caption) return script.caption;
    if (script?.hook) return script.hook;
  } catch {
    // No matching script (e.g. a manually dropped mp4) — fall through.
  }
  return process.env.BLOTATO_DEFAULT_CAPTION || '';
}

async function main() {
  if (process.argv.includes('--accounts')) {
    const items = await listAccounts();
    if (items.length === 0) {
      console.log('No connected accounts found. Connect TikTok in the Blotato dashboard first.');
      return;
    }
    console.log('Connected accounts (use the id as BLOTATO_TIKTOK_ACCOUNT_ID):\n');
    for (const a of items) {
      console.log(`  ${a.platform || '?'}  id=${a.id}  ${a.username ? '@' + a.username : ''} ${a.fullname || ''}`.trimEnd());
    }
    return;
  }

  const accountId = process.env.BLOTATO_TIKTOK_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      'Missing BLOTATO_TIKTOK_ACCOUNT_ID in .env. Run `node src/postBlotato.js --accounts` ' +
        'to list your connected accounts and copy the TikTok account id.'
    );
  }

  const videoPath = process.argv.find((a) => a.endsWith('.mp4')) || (await latestRenderedVideo());
  const caption = await captionFor(videoPath);
  const scheduledTime = process.env.BLOTATO_SCHEDULED_TIME || undefined;

  console.log(`Posting ${videoPath} to TikTok via Blotato...`);
  console.log(`  caption: ${caption ? JSON.stringify(caption) : '(empty)'}`);

  console.log('  uploading video to Blotato media store...');
  const mediaUrl = await uploadLocalFile(videoPath);
  console.log(`  hosted at ${mediaUrl}`);

  console.log(`  creating TikTok post${scheduledTime ? ` (scheduled for ${scheduledTime})` : ''}...`);
  const { postSubmissionId } = await createTikTokPost({ accountId, mediaUrl, caption, scheduledTime });
  console.log(`  submitted (postSubmissionId: ${postSubmissionId}).`);

  if (scheduledTime) {
    console.log('\nDone. Post is scheduled — Blotato will publish it at the requested time.');
    return;
  }

  console.log('  waiting for TikTok to confirm publish...');
  const final = await pollStatus(postSubmissionId);
  if (final?.status === 'published') {
    console.log('\nDone. Video is live on TikTok. 🎉');
  } else if (final?.status === 'failed') {
    console.log(`\nBlotato reports the post FAILED: ${JSON.stringify(final)}`);
    process.exitCode = 1;
  } else {
    console.log('\nSubmitted. Still processing after the polling window — check the Blotato dashboard.');
  }
}

main().catch((err) => {
  console.error('Blotato post failed:', err.message);
  process.exit(1);
});
