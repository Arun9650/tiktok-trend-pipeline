# Deploy: automated TikTok repost on AWS

Runs the repost pipeline hands-off in AWS:

- **Gather once** → picks the top *N* (default 5) videos, edits them, and writes them
  into `queue.json` spaced 3h apart, all on a persistent **EFS** disk.
- **Post ~every 3 hours** → an **EventBridge** schedule polls every 30 min; a Fargate task
  publishes each queued clip via Blotato once its scheduled slot arrives, with a live 3h-gap
  safety check. (Polling finer than the 3h cadence avoids the drift a coarse 3h tick would
  cause; the min 3h gap is still guaranteed.)

No always-on server. Rough cost: the 30-min poll launches ~48 short Fargate tasks/day
(most are no-ops that exit in seconds), so ~$1–3/month, plus a few cents of EFS storage and
logs. Disable the schedule between batches (see below) to drop the idle cost to near zero.

```
EventBridge (rate: 30 minutes)
      │  RunTask (default command = autopost)
      ▼
  ECS Fargate task ──mounts──> EFS /mnt/repost-data  (queue.json, posting-log.json, ready/*.mp4)
      ▲
      └── one-time GATHER run (command override = pipeline.js) fills EFS
```

## What gets created (one CloudFormation stack)

ECR repo · EFS filesystem + mount targets + access point · ECS cluster · one Fargate
task definition · IAM roles · CloudWatch log group · EventBridge schedule (every 3h) ·
3 SSM SecureString parameters for the secrets.

## Prerequisites

- **AWS CLI v2**, logged in (`aws sts get-caller-identity` works).
- **Docker Desktop** running (builds the Linux image).
- Your **Blotato API key + TikTok account id** and **Apify token**.

## Steps

1. Copy the config and fill it in:
   ```powershell
   copy deploy\.env.deploy.example deploy\.env.deploy
   # edit deploy\.env.deploy: AWS_REGION + the 3 secrets (accounts/hashtags optional)
   ```
2. From the repo root, run:
   ```powershell
   ./deploy/deploy.ps1
   ```
   It stores the secrets, deploys the stack, builds + pushes the image, and kicks off the
   one-time gather run.
3. Watch it work:
   ```powershell
   aws logs tail /ecs/tiktok-repost --region <your-region> --follow
   ```
   The gather logs should end with `N clip(s) queued`. From then on the posting task fires
   every 3 hours by itself.

## Common operations

**Fresh batch later** (re-run gather; already-posted sources are skipped automatically):
```powershell
aws ecs run-task --region <region> --cluster tiktok-repost --task-definition tiktok-repost `
  --launch-type FARGATE --network-configuration file://net.json `
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/repost/pipeline.js"]}]}'
```
(`deploy.ps1` prints a ready-to-use version of this at the end.)

**Pause / resume posting** (disable the polling schedule without deleting anything — also
the way to stop the small idle polling cost between batches):
```powershell
aws scheduler update-schedule --name tiktok-repost-post-poll --region <region> --state DISABLED
```

**Change cadence** — the time between posts is the **3h gap**, not the poll interval. To post
e.g. every 6h, raise the `MinGapHours` (and `MaxPostsPerDay`) parameter defaults in
`repost-stack.yaml` and re-run `deploy.ps1`. Leave the `rate(30 minutes)` poll as-is (it only
needs to be finer than the gap).

**Tear everything down:**
```powershell
aws cloudformation delete-stack --region <region> --stack-name tiktok-repost
```
(EFS empties on stack delete because the access point/filesystem are stack-managed; the
ECR repo empties on delete too.)

## Test without posting for real (recommended first pass)

Add `REPOST_DRY_RUN=true` as an env var on the task definition (in `repost-stack.yaml`,
under `Environment:`) and redeploy. The pipeline runs end to end — discovers, downloads,
edits, queues — but logs `[dry-run] would post ...` instead of publishing. Remove it and
redeploy once you're happy.

## Notes

- **Secrets** live in SSM Parameter Store as SecureString and are injected at task start —
  they are never baked into the image or the template.
- **Which content** it gathers is controlled by `REPOST_ACCOUNTS` (direct handles) or
  `REPOST_HASHTAGS` (creator discovery) in `.env.deploy`.
- The **3h gap** is enforced in code (`autopost.js` `withinGap`), independent of the schedule
  tick, so an early/duplicated tick can never double-post.
