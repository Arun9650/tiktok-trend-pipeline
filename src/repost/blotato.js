import { config } from './config.js';

// Minimal Blotato client for the repost pipeline's auto-poster. Mirrors the
// endpoints the generation pipeline's postBlotato.js uses (media upload +
// /posts), but exported as functions so Stage 6 can call them in a loop.

const BASE_URL = 'https://backend.blotato.com/v2';

const TIKTOK_DEFAULTS = {
  privacyLevel: process.env.BLOTATO_TIKTOK_PRIVACY || 'PUBLIC_TO_EVERYONE',
  disabledComments: process.env.BLOTATO_TIKTOK_DISABLE_COMMENTS === 'true',
  disabledDuet: process.env.BLOTATO_TIKTOK_DISABLE_DUET === 'true',
  disabledStitch: process.env.BLOTATO_TIKTOK_DISABLE_STITCH === 'true',
  isBrandedContent: process.env.BLOTATO_TIKTOK_BRANDED_CONTENT === 'true',
  isYourBrand: process.env.BLOTATO_TIKTOK_YOUR_BRAND === 'true',
  isAiGenerated: process.env.BLOTATO_TIKTOK_AI_GENERATED !== 'false',
};

async function blotato(endpoint, { method = 'GET', body } = {}) {
  if (!config.blotatoApiKey) {
    throw new Error('Missing BLOTATO_API_KEY in .env (Blotato > Settings > API).');
  }
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'blotato-api-key': config.blotatoApiKey,
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

/** Upload raw mp4 bytes to Blotato's media store, return the public URL. */
export async function uploadMedia(filename, bytes) {
  const { presignedUrl, publicUrl } = await blotato('/media/uploads', {
    method: 'POST',
    body: { filename },
  });
  if (!presignedUrl || !publicUrl) throw new Error('Unexpected /media/uploads response.');
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Presigned upload failed (${put.status}): ${await put.text()}`);
  return publicUrl;
}

/** Create (optionally scheduled) a TikTok post pointing at a hosted media URL. */
export async function createTikTokPost({ accountId, mediaUrl, caption, scheduledTime }) {
  const payload = {
    post: {
      accountId: String(accountId),
      content: { text: caption || '', mediaUrls: [mediaUrl], platform: 'tiktok' },
      target: { targetType: 'tiktok', ...TIKTOK_DEFAULTS },
    },
    ...(scheduledTime ? { scheduledTime } : {}),
  };
  return blotato('/posts', { method: 'POST', body: payload });
}
