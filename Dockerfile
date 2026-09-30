# Container image for the TikTok repost pipeline on AWS Fargate.
# Runs as one always-on task: src/repost/serve.js schedules the gather and
# autopost jobs internally with node-cron (gather daily + on startup, autopost
# every 30m), so no external EventBridge schedule is needed. Posting time is
# driven by each queue entry's scheduled time (set 3h apart at gather), with
# autopost's live 3h-gap check as the safety net.
# The individual stages are still runnable standalone by overriding the command
# (e.g. `node src/repost/pipeline.js` for a one-off gather).
# ffmpeg is required by the Stage 4 re-clip step (src/repost/reclip.js); the
# app talks to it via FFMPEG_PATH=ffmpeg (set in the task def env).
FROM node:20-slim

# ffmpeg for re-clipping/caption burn-in; ca-certificates for HTTPS to
# Apify/Blotato/TikTok CDN. Clean apt lists to keep the image small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps only. Storage uses the local (EFS) backend so the optional
# @aws-sdk/client-s3 isn't needed; --omit=optional keeps it out of the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

# App source. Only src/ is needed at runtime (see .dockerignore for exclusions).
COPY src ./src

# State + video files live on the mounted EFS volume, not the image.
ENV REPOST_DATA_DIR=/mnt/repost-data \
    REPOST_LOCAL_RAW_DIR=/mnt/repost-data/raw \
    REPOST_LOCAL_READY_DIR=/mnt/repost-data/ready \
    FFMPEG_PATH=ffmpeg \
    NODE_ENV=production

# Default: the long-running scheduler (gather + autopost via node-cron).
CMD ["node", "src/repost/serve.js"]
