import http from 'http';
import { config, normalizeHandle } from './config.js';
import { runGather } from './pipeline.js';
import { readQueue } from './postQueue.js';

// Stage 0: Input UI.
// A single-page form to submit any mix of accounts, hashtags, and names, plus a
// "Gather" button that fires the whole pipeline. Built on Node's http module so
// there's no extra dependency to install — this is a control panel, not a
// product surface. A gather run is long (scrape + download + ffmpeg), so the
// endpoint kicks it off in the background and returns immediately; watch the
// server console for progress and refresh the queue view for results.

const splitLines = (s) =>
  String(s || '')
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

let running = false;
let lastResult = null;
let lastError = null;

const PAGE = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Repost Pipeline</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}
  h1{font-size:22px} label{display:block;font-weight:600;margin:16px 0 4px}
  textarea{width:100%;box-sizing:border-box;height:70px;font-family:inherit;font-size:14px;padding:8px}
  button{margin-top:20px;padding:10px 20px;font-size:15px;font-weight:600;cursor:pointer}
  .muted{color:#666;font-size:13px} .row{display:flex;gap:8px;align-items:center}
  code{background:#f2f2f2;padding:1px 5px;border-radius:3px}
  #status{margin-top:16px;padding:10px;border-radius:6px;background:#f6f6f6;min-height:20px}
</style></head><body>
<h1>TikTok Repost Pipeline</h1>
<p class="muted">Submit any mix of the three. Handles may include or omit <code>@</code>.
Gather runs stages 1–5 (resolve → discover → download → re-clip+caption → schedule).
Posting (stage 6) runs on the 3-hour cadence via <code>npm run repost:post</code>.</p>
<form id="f">
  <label>TikTok account handles</label>
  <textarea name="accounts" placeholder="@tradermax, @fx.daily"></textarea>
  <label>Hashtags</label>
  <textarea name="hashtags" placeholder="daytrading, forex, stockmarket"></textarea>
  <label>People's names</label>
  <textarea name="names" placeholder="Ross Cameron, Humbled Trader"></textarea>
  <div class="row"><button type="submit">Gather</button>
  <a href="/queue" target="_blank" class="muted">View posting queue →</a></div>
</form>
<div id="status">Idle.</div>
<script>
  const f = document.getElementById('f'), s = document.getElementById('status');
  async function poll(){ const r = await fetch('/status'); const j = await r.json();
    s.textContent = j.running ? 'Running… watch the server console. '+(j.lastError?'':'')
      : (j.lastError ? 'Last run error: '+j.lastError
        : (j.lastResult ? 'Last run queued '+j.lastResult.queued+' clip(s) from '+j.lastResult.handles+' account(s).' : 'Idle.'));
    if(j.running) setTimeout(poll, 2000); }
  f.addEventListener('submit', async (e)=>{ e.preventDefault();
    const fd = new FormData(f);
    const body = { accounts: fd.get('accounts'), hashtags: fd.get('hashtags'), names: fd.get('names') };
    s.textContent = 'Starting…';
    const r = await fetch('/gather', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    if(r.status===409){ s.textContent = 'A run is already in progress.'; }
    poll();
  });
</script>
</body></html>`;

function send(res, status, body, type = 'text/html') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

async function handleGather(req, res) {
  if (running) return send(res, 409, JSON.stringify({ error: 'already running' }), 'application/json');
  const body = await readBody(req);
  const input = {
    accounts: splitLines(body.accounts).map(normalizeHandle).filter(Boolean),
    hashtags: splitLines(body.hashtags),
    names: splitLines(body.names),
  };
  if (!input.accounts.length && !input.hashtags.length && !input.names.length) {
    return send(res, 400, JSON.stringify({ error: 'no input provided' }), 'application/json');
  }
  running = true;
  lastError = null;
  // Fire-and-forget: the run outlives this request. Errors are captured for the
  // status endpoint rather than crashing the server.
  runGather(input)
    .then((r) => { lastResult = { queued: r.queued.length, handles: r.handles.length }; })
    .catch((err) => { lastError = err.message; })
    .finally(() => { running = false; });
  send(res, 202, JSON.stringify({ started: true }), 'application/json');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return send(res, 200, PAGE());
    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, JSON.stringify({ running, lastResult, lastError }), 'application/json');
    }
    if (req.method === 'GET' && req.url === '/queue') {
      const q = await readQueue();
      return send(res, 200, JSON.stringify(q, null, 2), 'application/json');
    }
    if (req.method === 'POST' && req.url === '/gather') return handleGather(req, res);
    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), 'application/json');
  }
});

server.listen(config.uiPort, () => {
  console.log(`Repost pipeline UI on http://localhost:${config.uiPort}`);
  console.log('Submit accounts/hashtags/names and hit Gather. Posting runs separately via `npm run repost:post`.');
});
