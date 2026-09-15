// Resolve a public TikTok webVideoUrl to a fresh, downloadable, no-watermark
// mp4 URL. Same approach the generation pipeline's renderVideo.js uses: TikTok
// blocks automated downloads from most IPs and its scraped CDN links expire in
// hours, so tikwm re-resolves the public URL to a fresh file on its own CDN.

const DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export async function resolveClipUrl(webVideoUrl) {
  const res = await fetch(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(webVideoUrl)}`);
  if (!res.ok) throw new Error(`tikwm request failed (${res.status})`);
  const { code, msg, data } = await res.json();
  if (code !== 0 || !data?.play) {
    throw new Error(`tikwm could not resolve clip: ${msg || 'no video url'}`);
  }
  const url = data.hdplay || data.play;
  return url.startsWith('http') ? url : `https://www.tikwm.com${url}`;
}

/** Fetch a URL to a Buffer with a browser-like UA (TikTok CDN rejects others). */
export async function downloadBytes(url) {
  const res = await fetch(url, { headers: DOWNLOAD_HEADERS });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
