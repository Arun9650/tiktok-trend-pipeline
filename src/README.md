# WhiteBeard TikTok Trend Pipeline

Fetches trending trading/fintech TikTok content, generates a script tied to a
WhiteBeard angle, and sends it to you on Telegram for approval before anything
gets rendered or posted.

## What this does right now

1. **Fetch trends** (`src/fetchTrends.js`) — pulls the dataset from your Apify
   TikTok Scraper run (the one you already tested with the hashtag list),
   filters out non-trading content and low-engagement videos using
   share-to-play ratio, and groups the survivors by trending sound.
2. **Generate script** (`src/generateScript.js`) — sends the top trend groups
   to Groq with a prompt tuned for WhiteBeard's audience (fintech founders and
   brokers, not retail traders), and gets back a structured hook/beats/caption.
3. **Review** (`src/telegramReview.js`) — posts each script to your Telegram
   with Approve/Reject buttons. Nothing moves forward without your tap.
4. **Handoff** — approved scripts get saved as JSON in `./approved-scripts/`.
   That's your stopping point for now; the next piece to build is the
   Remotion render step that turns an approved script into an actual video.

## Setup

```bash
cd tiktok-trend-pipeline
npm install
cp .env.example .env
```

Fill in `.env`:
- `APIFY_TOKEN` — from your Apify account settings.
- `APIFY_DATASET_ID` — grab this from the Runs tab of the scraper you already
  ran (click the run, the dataset ID is in the URL or the API tab). Set this
  if you want to reuse a run you already paid for. Leave blank and the
  pipeline will trigger a fresh scrape instead.
- `GROQ_API_KEY` — same key you're using for thepawn.ai.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — you can reuse your thepawn.ai
  bot and just point it at a different chat, or make a new bot via
  @BotFather if you want the approvals in a separate channel.

## Run it

```bash
npm start
```

Or just check what trends would get picked up without spending Groq credits:

```bash
npm run fetch-only
```

## Tuning

- `MIN_SHARE_RATIO` and `MIN_PLAY_COUNT` in `.env` control how strict the
  filtering is. If nothing clears the bar, lower these first.
- `TOP_N_TRENDS` caps how many videos get ranked before grouping by sound.
  Keep this low while you're testing so you're not sending yourself 20
  approval requests in a row.
- `TRADING_KEYWORDS` in `fetchTrends.js` is the keyword list used to filter
  out off-topic videos that only matched on a broad hashtag like `#fyp`. Add
  to it if you notice relevant videos getting filtered out.

## Automating it (no manual `npm start` needed)

`src/scheduler.js` runs the pipeline on a timer using `node-cron`, so it fires
on its own without you triggering it.

```bash
npm install
npm run schedule
```

That starts a long-running process. Leave the terminal open (or run it under
a process manager like `pm2`, see below) and it'll fire automatically on the
schedule set by `PIPELINE_CRON_SCHEDULE` in `.env`. Default is 10 AM and 6 PM
IST daily. Change the cron string to adjust cadence, e.g. `0 9 * * 1,3,5` for
9 AM Monday/Wednesday/Friday only.

**Important:** if `LOCAL_DATASET_PATH` is set in your `.env`, every scheduled
run will re-read that same static file instead of pulling fresh trend data.
That's fine for testing, but leave it blank once you're running this on a
schedule, so each run actually fetches new trends from Apify.

**Keeping it running long-term:** a terminal window left open will die if
your machine sleeps or you close it by accident. For anything beyond testing,
run it under [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start src/scheduler.js --name whitebeard-tiktok
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

`pm2 logs whitebeard-tiktok` shows you the pipeline output live, and
`pm2 restart whitebeard-tiktok` restarts it if you change `.env`.

## Rendering approved scripts into video

`src/renderVideo.js` uses Remotion to turn an approved script into an actual
vertical (1080x1920) MP4: your hook, beats, and CTA as timed text over a dark
animated background with the WhiteBeard wordmark.

```bash
npm install
npm run render
```

With no argument it grabs the most recently approved script from
`./approved-scripts` automatically. To render a specific one:

```bash
npm run render -- ./approved-scripts/1755123456-Motivation.json
```

Output lands in `./rendered-videos/`. First run downloads a headless Chromium
build for rendering, expect that one to take a few extra minutes; after that
renders are quick.

## 5. Auto-post to TikTok (Blotato)

`src/postBlotato.js` publishes a rendered video straight to TikTok through
[Blotato](https://help.blotato.com/api/start). Blotato owns the TikTok OAuth
connection, so this posts directly to the profile — no audited-app wait and no
manual inbox step (that's the `npm run upload` fallback in `uploadTikTok.js`).

One-time setup: connect TikTok in the Blotato dashboard, put `BLOTATO_API_KEY`
in `.env`, then find your account id:

```bash
npm run blotato-accounts
```

Copy the TikTok `id` into `BLOTATO_TIKTOK_ACCOUNT_ID`, then post:

```bash
npm run post                                   # posts the latest rendered video
npm run post -- ./rendered-videos/foo.mp4      # posts a specific file
```

The caption comes from the matching approved script automatically. Set
`BLOTATO_SCHEDULED_TIME` (ISO 8601) to schedule instead of posting immediately;
see `.env.example` for the TikTok privacy/comment/AI-disclosure toggles.

**Still silent by design** — see the note below. If you want the trending
sound, use `npm run upload` (Upload-to-Inbox) and add it in-app instead.

**The video is silent on purpose.** There's no way to legally bake in the
actual trending TikTok sound through code, that audio belongs to whoever
posted the original clip, and TikTok's Content Posting API doesn't expose
their sound library for API use anyway. The standard workaround: upload the
video as a draft (Upload to Inbox mode, once your Content Posting API access
is approved), then add the trending sound from inside the TikTok app before
you hit publish. Same workflow real creators use when they want a specific
trending audio.

Caption and hashtags aren't rendered into the video itself, they're meant for
the TikTok post description when you publish, whether that's manual upload
now or automated later through the Content Posting API.

## Publishing options

- **Blotato (`npm run post`)** — direct auto-post to profile, recommended. See
  step 5 above.
- **TikTok Content Posting API (`npm run upload`)** — Upload-to-Inbox mode,
  which works with an unaudited app; the video lands in drafts and you add the
  trending sound + publish in-app. Direct-post through this API needs an
  audited app (register at developers.tiktok.com; review takes 2-6 weeks).
