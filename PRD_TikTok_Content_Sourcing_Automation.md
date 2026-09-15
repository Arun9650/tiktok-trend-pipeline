# PRD: TikTok Content Sourcing & Auto-Repost Pipeline

**Author:** Arun Kumar
**Stakeholder:** Shamik Raja
**Status:** Draft v1
**Date:** September 15, 2026

## Background

We already have a TikTok automation pipeline that generates scripts and renders original videos through Remotion. This PRD covers a separate, new pipeline: instead of generating content from scratch, it sources existing high-performing TikTok videos from accounts, hashtags, or people we specify, re-clips and re-captions them, and reposts them on our own accounts on a schedule.

The goal is to get this working end-to-end on one account first. Once that account is running clean, we replicate the setup across other accounts.

## Problem

Right now there's no way to systematically pull proven, high-performing content from other TikTok accounts and turn it into fresh posts for our own accounts. Everything is manual: finding accounts, checking which videos performed, downloading them, editing them, and posting them. This doesn't scale past one person doing it by hand.

## Goal

Build a single workflow, controlled through a simple UI, that:
1. Takes an input (TikTok account, hashtag, or person's name)
2. Finds and ranks the best-performing source videos
3. Downloads and re-edits them (chop, caption, re-score with trending music)
4. Posts them automatically to our account, respecting platform rate limits

Ship this on one pilot account first. Don't build for scale until stage one works.

## Non-goals (for v1)

- Multi-account rollout (comes after the pilot account works)
- Platforms other than TikTok (mentioned rate limit differences for other platforms, but scope here is TikTok only)
- Fully automated posting without any review step, if legal/compliance flags a need for one (open question below)

## User Flow / Pipeline Stages

### Stage 0: Input UI
A simple interface where the user can submit one of three input types:
- A direct list of TikTok account handles
- A list of hashtags
- A list of people's names

The UI accepts any combination of the three and triggers the workflow with a single action (e.g. a "Gather" button).

### Stage 1: Account Resolution
Goal: end this stage with a clean list of TikTok account handles to scan.

- If the input is already account handles, pass them through directly.
- If the input is hashtags or names, search TikTok to find accounts that post content matching those hashtags or names.
- Output: a deduplicated list of TikTok account handles.

### Stage 2: Video & Sound Discovery
For each account in the list from Stage 1:
- Scan their video history.
- Rank videos by view count and identify the top performers.
- For each top video, extract the audio/music track used.
- Output: a shortlist of high-performing videos per account, each tagged with its original sound.

### Stage 3: Download & Raw Storage
- Download the shortlisted videos.
- Store the raw files in an S3 bucket (raw source bucket).

### Stage 4: Re-clip & Caption
- Chop the raw video into a new edited clip (Opus Clip-style re-cutting).
- Superimpose a large, attention-grabbing text caption directly on the video (burned-in, not a platform caption field) — this is the format most clippers use to hook viewers.
- Store the resulting edited video in a second S3 bucket (ready-to-post bucket). No new music is added at this stage; that happens in Stage 5.

### Stage 5: Music Matching & Scheduling
- Pull the day's best-performing/trending sounds.
- Attach a relevant trending sound to each ready-to-post video.
- Queue the video for posting.

### Stage 6: Auto-Posting
- Post automatically to the target TikTok account.
- Enforce a minimum gap of 3 hours between posts on the same TikTok account. This matches the current rule of thumb used for GoldPesa's TikTok posting cadence (versus roughly 1 hour on other platforms), and it's the cadence that hasn't caused any problems so far.

## Functional Requirements

| Stage | Requirement |
|---|---|
| Input UI | Accept accounts, hashtags, or names; support mixed input in a single submission |
| Account Resolution | Convert hashtags/names into resolved account handles; dedupe results |
| Video Discovery | Rank videos per account by views; extract audio metadata per video |
| Storage | Two distinct S3 buckets: raw downloads, and edited/ready-to-post |
| Editing | Automated re-clipping + burned-in caption overlay, no manual editing step required |
| Music | Daily trending sound lookup, applied per video before posting |
| Posting | Automated posting with enforced 3-hour minimum interval per account |

## Constraints

- TikTok posting cadence: max 1 post per 3 hours, per account. This is a hard rule, not a target.
- Pilot on one account only until the full pipeline is proven, then replicate.

## Open Questions

- **Source video legality/ToS risk:** Re-posting other creators' content, even edited, carries platform and IP risk. Needs a decision on how source videos get chosen and whether any manual review step is required before posting.
- **Video/audio scanning method:** Are we scraping TikTok directly, using a third-party API (e.g. an unofficial TikTok data API), or something else? This determines feasibility and cost for Stages 1-2.
- **Trending sound source:** Where does "today's best music" come from — TikTok's own trending sounds list, or a separate signal?
- **Volume per run:** How many source videos/accounts per batch, and how many output posts per day are we targeting per account?
- **Caption content:** Auto-generated caption text, or pulled from the original video's context (e.g. a summary of what's happening)?
- **Review step:** Fully automated post, or a Telegram-style approval step before it goes live, similar to the existing generation pipeline?

## Success Criteria (Pilot Account)

- End-to-end pipeline runs without manual intervention from input submission to live post.
- Videos posted maintain the 3-hour minimum cadence with zero violations.
- Source videos are correctly matched to accounts/hashtags/names submitted.
- Team can review pilot account performance and decide on replication to additional accounts.

## Next Steps

1. Confirm scanning/scraping method for TikTok account and video data (open question above).
2. Build Stage 0-1 (Input UI + Account Resolution) first, since everything downstream depends on it.
3. Wire up the two S3 buckets and confirm bucket structure/naming conventions.
4. Build editing stage (re-clip + caption) as a standalone service, since it can be tested independently of the scanning/posting stages.
5. Integrate with the existing posting/scheduling logic already used for the generation pipeline, adding the 3-hour rate limit check for this pipeline specifically.
