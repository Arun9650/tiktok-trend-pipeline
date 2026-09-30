// Resolve a public TikTok webVideoUrl to a fresh, downloadable, no-watermark
// mp4 URL. Same approach the generation pipeline's renderVideo.js uses: TikTok
// blocks automated downloads from most IPs and its scraped CDN links expire in
// hours, so tikwm re-resolves the public URL to a fresh file on its own CDN.

const DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tikwm's free tier is capped at ~1 request/second; when several clips are
// resolved back-to-back it answers with a "Free Api Limit" error (or HTTP 429)
// instead of the video. So retry on those, backing off past the 1s window,
// rather than letting the download fail. Non-rate-limit errors fail fast.
export async function resolveClipUrl(webVideoUrl, { retries = 5, retryDelayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(webVideoUrl)}`);
    if (res.ok) {
      const { code, msg, data } = await res.json();
      if (code === 0 && data?.play) {
        const url = data.hdplay || data.play;
        return url.startsWith('http') ? url : `https://www.tikwm.com${url}`;
      }
      // Rate-limited: wait out the 1s window and try again.
      if (/limit/i.test(msg || '') && attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`tikwm could not resolve clip: ${msg || 'no video url'}`);
    }
    // HTTP-level failure (e.g. 429 Too Many Requests): retry a few times too.
    if (attempt < retries) {
      await sleep(retryDelayMs);
      continue;
    }
    throw new Error(`tikwm request failed (${res.status})`);
  }
}

/** Fetch a URL to a Buffer with a browser-like UA (TikTok CDN rejects others). */
export async function downloadBytes(url) {
  const res = await fetch(url, { headers: DOWNLOAD_HEADERS });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
