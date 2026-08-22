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

## Not built yet

- Video rendering (Remotion) from an approved script.
- TikTok Content Posting API integration. Register your app now at
  developers.tiktok.com since review takes weeks, but you don't need it
  until the render step exists.
