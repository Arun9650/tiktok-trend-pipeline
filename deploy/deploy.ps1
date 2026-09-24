#requires -Version 5.1
<#
  One-shot deploy for the serverless TikTok repost pipeline.

  Run from the repo root:  ./deploy/deploy.ps1

  It will:
    1. Read deploy/.env.deploy
    2. Store the 3 secrets in SSM Parameter Store (SecureString)
    3. Auto-detect the default VPC + public subnets (unless you set them)
    4. Deploy the CloudFormation stack (ECR, EFS, ECS, IAM, 3h schedule)
    5. Build + push the Docker image to the new ECR repo
    6. Run the GATHER task once (fills EFS with the top N clips + queue.json)

  After that, EventBridge runs the posting task every 3 hours on its own.

  Prereqs: AWS CLI v2 (logged in), Docker Desktop running.
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

# --- 1. Load deploy/.env.deploy ---
$EnvFile = Join-Path $ScriptDir '.env.deploy'
if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile. Copy deploy/.env.deploy.example to it and fill it in."
}
$cfg = @{}
foreach ($line in Get-Content $EnvFile) {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

function Need($k) {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($cfg[$k])) {
    throw "Set $k in deploy/.env.deploy"
  }
  return $cfg[$k]
}
function Opt($k, $default = '') {
  if ($cfg.ContainsKey($k) -and -not [string]::IsNullOrWhiteSpace($cfg[$k])) { return $cfg[$k] }
  return $default
}

$Region      = Need 'AWS_REGION'
$Project     = Opt  'PROJECT_NAME' 'tiktok-repost'
$BlotatoKey  = Need 'BLOTATO_API_KEY'
$BlotatoAcct = Need 'BLOTATO_ACCOUNT_ID'
$ApifyToken  = Need 'APIFY_TOKEN'
$Hashtags    = Opt  'REPOST_HASHTAGS' '#fintok,#investing,#stocktok,#trading,#personalfinance'
$Accounts    = Opt  'REPOST_ACCOUNTS' ''
$MaxOutputs  = Opt  'MAX_OUTPUTS_PER_RUN' '5'

Write-Host "==> Deploying '$Project' to $Region" -ForegroundColor Cyan

# --- 2. Secrets -> SSM SecureString (CloudFormation can't create SecureStrings) ---
function Put-Secret($name, $value) {
  aws ssm put-parameter --region $Region --name $name --type SecureString `
    --value $value --overwrite --output text | Out-Null
  Write-Host "    ssm: $name"
}
Write-Host "==> Storing secrets in SSM Parameter Store" -ForegroundColor Cyan
Put-Secret "/$Project/BLOTATO_API_KEY"    $BlotatoKey
Put-Secret "/$Project/BLOTATO_ACCOUNT_ID" $BlotatoAcct
Put-Secret "/$Project/APIFY_TOKEN"        $ApifyToken

# --- 3. VPC + subnets (auto-detect default VPC unless provided) ---
$VpcId   = Opt 'VPC_ID' ''
$Subnets = Opt 'SUBNET_IDS' ''
if ([string]::IsNullOrWhiteSpace($VpcId)) {
  $VpcId = aws ec2 describe-vpcs --region $Region --filters Name=isDefault,Values=true `
    --query 'Vpcs[0].VpcId' --output text
  if ($VpcId -eq 'None' -or [string]::IsNullOrWhiteSpace($VpcId)) {
    throw "No default VPC found. Set VPC_ID and SUBNET_IDS in .env.deploy."
  }
}
if ([string]::IsNullOrWhiteSpace($Subnets)) {
  $subnetList = (aws ec2 describe-subnets --region $Region `
    --filters "Name=vpc-id,Values=$VpcId" "Name=map-public-ip-on-launch,Values=true" `
    --query 'Subnets[].SubnetId' --output text) -split '\s+' | Where-Object { $_ }
  if ($subnetList.Count -lt 2) {
    throw "Need >=2 public subnets in $VpcId; found $($subnetList.Count). Set SUBNET_IDS manually."
  }
  $Subnets = ($subnetList | Select-Object -First 2) -join ','
}
# The stack creates exactly 2 EFS mount targets (one per AZ), so tasks must run
# in exactly those 2 subnets or an EFS mount could fail. Cap to the first 2.
$subnetArr = $Subnets.Split(',') | Where-Object { $_ } | Select-Object -First 2
if ($subnetArr.Count -lt 2) { throw "Need exactly 2 subnets in different AZs; got $($subnetArr.Count)." }
$Subnets = $subnetArr -join ','
Write-Host "    vpc: $VpcId  subnets: $Subnets"

# --- 4. Deploy the stack ---
Write-Host "==> Deploying CloudFormation stack" -ForegroundColor Cyan
aws cloudformation deploy `
  --region $Region `
  --stack-name $Project `
  --template-file (Join-Path $ScriptDir 'repost-stack.yaml') `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides `
    "ProjectName=$Project" `
    "VpcId=$VpcId" `
    "SubnetIds=$Subnets" `
    "RepostAccounts=$Accounts" `
    "RepostHashtags=$Hashtags" `
    "MaxOutputsPerRun=$MaxOutputs"

function Output($key) {
  aws cloudformation describe-stacks --region $Region --stack-name $Project `
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
}
$EcrUri     = Output 'EcrRepoUri'
$Cluster    = Output 'ClusterName'
$TaskDefArn = Output 'TaskDefArn'
$SgId       = Output 'SecurityGroupId'
$Registry   = $EcrUri.Split('/')[0]

# --- 5. Build + push image ---
Write-Host "==> Building + pushing image to $EcrUri" -ForegroundColor Cyan
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $Registry
docker build -t "${EcrUri}:latest" $RepoRoot
docker push "${EcrUri}:latest"

# --- 6. Run the gather task once (command override -> pipeline.js) ---
Write-Host "==> Running one-time GATHER task" -ForegroundColor Cyan
$net = @{
  awsvpcConfiguration = @{
    subnets          = $Subnets.Split(',')
    securityGroups   = @($SgId)
    assignPublicIp   = 'ENABLED'
  }
} | ConvertTo-Json -Compress -Depth 5
$ovr = @{
  containerOverrides = @(@{ name = 'app'; command = @('node', 'src/repost/pipeline.js') })
} | ConvertTo-Json -Compress -Depth 5

$netFile = Join-Path $env:TEMP "repost-net.json"
$ovrFile = Join-Path $env:TEMP "repost-ovr.json"
$net | Set-Content -Path $netFile -Encoding ascii
$ovr | Set-Content -Path $ovrFile -Encoding ascii

$taskArn = aws ecs run-task --region $Region --cluster $Cluster `
  --task-definition $TaskDefArn --launch-type FARGATE `
  --network-configuration "file://$netFile" `
  --overrides "file://$ovrFile" `
  --query 'tasks[0].taskArn' --output text
Remove-Item $netFile, $ovrFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Gather task started: $taskArn" -ForegroundColor Green
Write-Host ""
Write-Host "Watch it work:" -ForegroundColor Cyan
Write-Host "  aws logs tail /ecs/$Project --region $Region --follow"
Write-Host ""
Write-Host "Posting is now automatic: a poller runs every 30m and publishes each"
Write-Host "queued clip once its slot arrives, one every ~3 hours (3h min gap enforced)."
Write-Host "Re-run a fresh top-$MaxOutputs batch later with just the gather step:" -ForegroundColor Cyan
Write-Host "  aws ecs run-task --region $Region --cluster $Cluster --task-definition $Project ``"
Write-Host "    --launch-type FARGATE --network-configuration file://net.json ``"
Write-Host "    --overrides '{\""containerOverrides\"":[{\""name\"":\""app\"",\""command\"":[\""node\"",\""src/repost/pipeline.js\""]}]}'"
Write-Host ""
Write-Host "Tear everything down:" -ForegroundColor Cyan
Write-Host "  aws cloudformation delete-stack --region $Region --stack-name $Project"
