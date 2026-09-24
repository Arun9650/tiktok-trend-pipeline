# Container image for the TikTok repost pipeline on AWS Fargate.
# One image, two jobs: the ECS task definition supplies the command —
#   gather:  node src/repost/pipeline.js    (run once, fills the queue)
#   post:    node src/repost/autopost.js     (EventBridge polls every 30m)
# The poll cadence is well under the 3h gap; posting time is driven by each
# queue entry's scheduled time (set 3h apart at gather), with autopost's live
# 3h-gap check as the safety net. Polling finer than the cadence avoids the
# "6h drift" you'd get from a 3h tick racing the gap check.
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

# Default to the posting job; the gather task overrides this command.
CMD ["node", "src/repost/autopost.js"]
