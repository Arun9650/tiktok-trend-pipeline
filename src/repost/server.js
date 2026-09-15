import http from 'http';
import { config, normalizeHandle } from './config.js';
import { runGather } from './pipeline.js';
import { discoverFinanceCreators } from './discoverCreators.js';
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

// Separate state for the "find popular finance creators" job so it can run
// independently of a gather.
let creatorsRunning = false;
let creatorsResult = null; // array of creators, or null
let creatorsError = null;

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
  hr{margin:32px 0;border:none;border-top:1px solid #e2e2e2}
  button.secondary{background:#fff;border:1px solid #888}
  ul.creators{list-style:none;padding:0;margin:12px 0}
  ul.creators li{padding:8px 10px;border:1px solid #eee;border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;gap:10px;align-items:center}
  ul.creators a{font-weight:600;text-decoration:none;color:#0b62d6}
  ul.creators .meta{color:#666;font-size:12px;white-space:nowrap}
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

<hr>
<h1 style="font-size:18px">Discover popular finance creators</h1>
<p class="muted">Searches finance hashtags on TikTok (via Apify) and lists the most-followed creators.
Use it to find accounts to feed into the Gather form above.</p>
<div class="row"><button id="findBtn" class="secondary" type="button">Find finance creators</button></div>
<div id="creatorStatus" class="muted" style="margin-top:10px"></div>
<ul id="creators" class="creators"></ul>
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

  const findBtn = document.getElementById('findBtn');
  const cStatus = document.getElementById('creatorStatus');
  const cList = document.getElementById('creators');
  function renderCreators(list){
    cList.innerHTML = '';
    (list||[]).forEach(c => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = c.profileUrl || ('https://www.tiktok.com/@'+c.handle);
      a.target = '_blank'; a.textContent = '@'+c.handle + (c.verified ? ' ✓' : '');
      const meta = document.createElement('span'); meta.className='meta';
      meta.textContent = (c.fans ? c.fans.toLocaleString()+' followers' : '') ;
      li.appendChild(a); li.appendChild(meta); cList.appendChild(li);
    });
  }
  async function pollCreators(){ const j = await (await fetch('/creators-status')).json();
    if(j.running){ cStatus.textContent='Searching finance creators… (can take a minute)'; findBtn.disabled=true; setTimeout(pollCreators, 2000); return; }
    findBtn.disabled=false;
    if(j.error){ cStatus.textContent='Error: '+j.error; return; }
    if(j.creators){ cStatus.textContent='Found '+j.creators.length+' creator(s):'; renderCreators(j.creators); }
    else cStatus.textContent='';
  }
  findBtn.addEventListener('click', async ()=>{
    cStatus.textContent='Starting…'; cList.innerHTML='';
    const r = await fetch('/find-creators', {method:'POST'});
    if(r.status===409) cStatus.textContent='Already searching…';
    pollCreators();
  });
  pollCreators();
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

function handleFindCreators(res) {
  if (creatorsRunning) return send(res, 409, JSON.stringify({ error: 'already running' }), 'application/json');
  creatorsRunning = true;
  creatorsError = null;
  creatorsResult = null;
  discoverFinanceCreators()
    .then((creators) => { creatorsResult = creators; })
    .catch((err) => { creatorsError = err.message; })
    .finally(() => { creatorsRunning = false; });
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
    if (req.method === 'POST' && req.url === '/find-creators') return handleFindCreators(res);
    if (req.method === 'GET' && req.url === '/creators-status') {
      return send(
        res,
        200,
        JSON.stringify({ running: creatorsRunning, creators: creatorsResult, error: creatorsError }),
        'application/json'
      );
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), 'application/json');
  }
});

server.listen(config.uiPort, () => {
  console.log(`Repost pipeline UI on http://localhost:${config.uiPort}`);
  console.log('Submit accounts/hashtags/names and hit Gather. Posting runs separately via `npm run repost:post`.');
});
