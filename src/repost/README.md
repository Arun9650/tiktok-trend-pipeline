# TikTok Content Sourcing & Auto-Repost Pipeline

Implements the PRD in `PRD_TikTok_Content_Sourcing_Automation.md`. This is a
**separate pipeline** from the script-generation one in `src/index.js`: instead
of generating originals, it sources existing high-performing videos from
accounts / hashtags / names you specify, re-clips and re-captions them, and
reposts them to your account on a 3-hour cadence.

> ⚠️ **ToS / IP risk.** Reposting other creators' content — even edited — carries
> platform and copyright risk (a PRD open question). The pipeline defaults to a
> **human approval step** (`REPOST_REQUIRE_APPROVAL=true`) so nothing goes live
> without a review. Keep it on until legal/compliance signs off.

## Pipeline stages

| Stage | File | What it does |
|---|---|---|
| 0 Input UI | `server.js` | Web form (accounts / hashtags / names) + Gather button |
| 1 Account resolution | `resolveAccounts.js` | Mixed input → deduped handle list (search resolves hashtags/names) |
| 2 Discovery | `discoverVideos.js` | Scan each account, rank by views, tag each top video with its sound |
| 3 Download + storage | `download.js`, `storage.js` | Download shortlist → **raw** bucket (S3 or local) |
| 4 Re-clip + caption | `reclip.js`, `caption.js` | ffmpeg chop + burned-in hook caption → **ready** bucket |
| 5 Sound + schedule | `trendingSounds.js`, `postQueue.js` | Attach a trending sound, queue with 3h spacing |
| 6 Auto-post | `autopost.js`, `postScheduler.js` | Post via Blotato, enforcing the 3h min gap per account |

`pipeline.js` orchestrates stages 1–5 (`runGather`). Stage 6 runs separately so
posting cadence is driven by wall-clock time, not by when a gather finishes.

## Run order (what to run first)

```bash
# 1. one-time install
npm install

# 2. create .env with at least: APIFY_TOKEN, an input (REPOST_ACCOUNTS or
#    REPOST_HASHTAGS or REPOST_NAMES), FFMPEG_PATH, and — to actually post —
#    BLOTATO_API_KEY + REPOST_BLOTATO_ACCOUNT_ID. Start with REPOST_DRY_RUN=true.

# 3. GATHER — resolve → discover → download → re-clip+caption → queue.
#    Processes ONE video per run by default (REPOST_MAX_OUTPUTS_PER_RUN=1).
npm run repost:gather          # headless, uses inputs from .env
#    …or drive it from the browser form instead:
npm run repost:ui              # http://localhost:3100, fill in + hit Gather

# 4. POST — publish whatever is due, enforcing the 3h gap per account.
npm run repost:post            # run this whenever a slot is due
npm run repost:schedule        # …or leave this running to post on a timer
```

So: **`repost:gather` first** (builds the queue), then **`repost:post`** (drains
it on cadence). Run `gather` again each time you want another clip queued — one
video per run keeps a pilot at exactly the 3h cadence. Keep `REPOST_DRY_RUN=true`
until you've eyeballed a queued clip, then flip it off for real posts.

Individual stages are runnable standalone for debugging:
`npm run repost:resolve`, `npm run repost:discover`.

**Find popular finance creators** — a discovery helper that searches finance
hashtags and lists the most-followed creators (a watch/source shortlist, it does
not repost anyone):

```bash
npm run repost:creators          # prints ranked creators + saves finance-creators.json
```

In the UI there's a **Find finance creators** button that runs the same thing
and shows the usernames (with follower counts, linked to their profiles). Tune
the search with `REPOST_FINANCE_TERMS` and `REPOST_MAX_CREATORS`.

## Configuration (.env)

Reuses `APIFY_TOKEN`, `BLOTATO_API_KEY`, `TELEGRAM_BOT_TOKEN/CHAT_ID`, and
`FFMPEG_PATH` from the existing pipeline. Repost-specific vars:

```bash
# --- Default inputs (comma-separated; UI overrides per run) ---
REPOST_ACCOUNTS=@tradermax,@fx.daily
REPOST_HASHTAGS=daytrading,forex
REPOST_NAMES=Ross Cameron

# --- Volume caps (keep low for the pilot) ---
REPOST_MAX_ACCOUNTS=5
REPOST_SEARCH_RESULTS=15          # results per hashtag/name search term
REPOST_VIDEOS_PER_ACCOUNT=30      # history depth scanned per account
REPOST_TOP_VIDEOS_PER_ACCOUNT=3   # top performers kept per account
REPOST_MIN_PLAYS=10000            # floor for "proven"
REPOST_MAX_OUTPUTS_PER_RUN=1      # process one video per gather run (raise to batch)

# --- Find popular finance creators ---
REPOST_FINANCE_TERMS=#fintok,#investing,#stocktok,#trading,#personalfinance,#finance
REPOST_MAX_CREATORS=20            # how many ranked creators to return

# --- Storage: set both buckets for S3, or leave unset for local dirs ---
AWS_REGION=us-east-1
REPOST_RAW_BUCKET=                # e.g. my-repost-raw   (needs @aws-sdk/client-s3)
REPOST_READY_BUCKET=             # e.g. my-repost-ready
REPOST_LOCAL_RAW_DIR=./repost-data/raw
REPOST_LOCAL_READY_DIR=./repost-data/ready

# --- Editing (Stage 4) — small black text (drawtext) + color-emoji overlay ---
FFMPEG_PATH=./bin/ffmpeg.exe
REPOST_CLIP_SECONDS=30            # length of the re-cut clip
REPOST_CLIP_START=0              # trim seconds off the start
REPOST_CAPTION_FONT=C:/Windows/Fonts/arialbd.ttf   # .ttf FILE path for the text
REPOST_CAPTION_SIZE=0.033         # font size as a fraction of frame height (small)
REPOST_CAPTION_COLOR=black        # text color
REPOST_CAPTION_Y=0.68            # caption block position from top (0.68 = lower third)
REPOST_EMOJI_STYLE=apple          # color emoji set: 'apple' or 'twemoji'
REPOST_EMOJI_CDN=                 # override the emoji image URL (must contain {code})
REPOST_CAPTION_OVERRIDE=          # force a fixed caption (testing)
REPOST_UNIQUIFY=true             # randomized grade+zoom so no repost is a pixel-dupe

# --- Trending sound (Stage 5) ---
REPOST_SOUND_SOURCE=discovered    # 'discovered' | 'apify'
REPOST_SOUND_ACTOR_ID=            # required if source=apify

# --- Posting (Stage 6) ---
REPOST_REQUIRE_APPROVAL=true      # Telegram approve/reject before queueing
REPOST_BLOTATO_ACCOUNT_ID=        # pilot account (falls back to BLOTATO_TIKTOK_ACCOUNT_ID)
REPOST_MIN_GAP_HOURS=3            # HARD rule — do not lower
REPOST_MAX_POSTS_PER_DAY=4
REPOST_DRY_RUN=false              # true = run everything but don't call Blotato
REPOST_POST_CRON=*/30 * * * *     # how often the poster checks for due posts
REPOST_UI_PORT=3100
```

## Design notes & open-question decisions

- **Scanning method** (open question): the existing `clockworks/tiktok-scraper`
  Apify actor covers profiles, hashtag, and search in one place, so both Stage 1
  and Stage 2 reuse it rather than adding a second data source.
- **Trending sound source** (open question): defaults to `discovered` — ranking
  the sounds already seen on the scanned high-performers, which is free and
  provably trending *in this niche*. Switch to `apify` for a dedicated actor.
- **Trending audio is metadata, not muxed.** As the generation pipeline's README
  explains, TikTok's API can't legally bake in a copyrighted sound and doesn't
  expose the sound library. The chosen sound rides along as metadata on each
  queued clip (add it in-app on publish, or mux a licensed asset yourself). We
  never claim to have muxed audio we don't own.
- **Caption content** (open question): derived from the source video's own
  caption text (hashtags/mentions/URLs stripped, length-capped), with a generic
  curiosity-hook fallback. Override with `REPOST_CAPTION_OVERRIDE`.
- **Caption rendering:** small black text on a transparent background, drawn with
  ffmpeg `drawtext`, positioned in the lower third and wrapped to a few centered
  lines. **Color emoji** are handled separately: neither drawtext nor libass
  renders color emoji on typical ffmpeg builds (they come out flat/monochrome),
  so emoji are stripped from the text and **overlaid as color PNG images** in a
  centered row just below the text (`emoji.js`). The artwork set is Apple-style
  by default (`REPOST_EMOJI_STYLE=apple`) or Twemoji (`=twemoji`). Text and
  emoji are both positioned in real frame pixels (the render probes the source
  dimensions with `ffmpeg -i`), so the two always line up regardless of source
  resolution.
  - *Licensing:* Apple's emoji designs are Apple's IP; the `apple` set
    redistributes them via a public CDN mirror the way many web apps do. If
    that's a concern, use `twemoji` (freely licensed).
- **Review step** (open question): defaults ON via Telegram. Set `AUTO_APPROVE=true`
  (or leave Telegram unconfigured) to run fully unattended in dev.
- **Every output is unique** — two independent guarantees:
  - *No source is reposted twice.* Each produced clip's source key (video id /
    URL) is recorded in `processed-sources.json`; the next gather run skips it
    and picks the next-best **new** video. So repeated runs never re-queue the
    same clip.
  - *No output is a pixel-dupe.* Each render applies a lightly **randomized**
    colour grade + micro-zoom (`REPOST_UNIQUIFY`) on top of the caption burn-in
    and full re-encode, so even two re-clips of the same source aren't
    byte-identical — which is what TikTok's duplicate/recycled-content detection
    keys on. (Verified: two renders of one source produce different hashes.)
- **3-hour rule is enforced twice**: once when scheduling (`postQueue.nextSlot`
  spaces the queue) and again live at post time (`autopost.withinGap` re-checks
  the posting log). The live check is the real guarantee — it holds even if the
  queue is hand-edited or two runs overlap.
- **Storage** is S3 when `REPOST_RAW_BUCKET`/`REPOST_READY_BUCKET` are set,
  otherwise local dirs under `./repost-data`, so the whole pipeline runs on a
  laptop with no AWS account. `@aws-sdk/client-s3` is an optional dependency,
  imported lazily only when S3 is configured.

## State files (git-ignored, under `./repost-data`)

- `queue.json` — scheduled clips awaiting posting.
- `posting-log.json` — record of actual posts per account; the source of truth
  for the 3h gap check. Delete it to reset the rate limiter.
- `processed-sources.json` — source video keys already turned into a post, so no
  source is reposted twice. Delete it to allow re-posting past sources.
