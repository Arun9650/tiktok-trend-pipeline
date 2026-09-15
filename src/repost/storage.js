import path from 'path';
import fs from 'fs/promises';
import { config } from './config.js';

// Storage abstraction for the two logical buckets the PRD calls for:
//   raw   — untouched source downloads (Stage 3)
//   ready — edited / ready-to-post clips (Stage 4)
//
// If REPOST_RAW_BUCKET / REPOST_READY_BUCKET are set we use real S3; otherwise
// we transparently fall back to local directories so the pipeline runs on a
// laptop with no AWS account. @aws-sdk/client-s3 is imported lazily so the
// dependency is only needed when S3 is actually configured.

let _s3; // cached S3 client
async function s3Client() {
  if (_s3) return _s3;
  let mod;
  try {
    mod = await import('@aws-sdk/client-s3');
  } catch {
    throw new Error(
      'S3 buckets are configured but @aws-sdk/client-s3 is not installed. ' +
        'Run `npm install @aws-sdk/client-s3`, or unset REPOST_RAW_BUCKET/' +
        'REPOST_READY_BUCKET to use local storage instead.'
    );
  }
  _s3 = { ...mod, client: new mod.S3Client({ region: config.s3Region }) };
  return _s3;
}

function bucketFor(kind) {
  return kind === 'raw' ? config.rawBucket : config.readyBucket;
}
function localDirFor(kind) {
  return kind === 'raw' ? config.localRawDir : config.localReadyDir;
}

/** True when we should talk to S3 for this bucket kind. */
export function usingS3(kind) {
  return Boolean(bucketFor(kind));
}

/**
 * Store bytes under `key` in the given bucket ('raw' | 'ready').
 * Returns a location descriptor: { backend, bucket?, key, path?, url }.
 */
export async function putObject(kind, key, bytes, contentType = 'video/mp4') {
  if (usingS3(kind)) {
    const { PutObjectCommand, client } = await s3Client();
    const bucket = bucketFor(kind);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })
    );
    return {
      backend: 's3',
      bucket,
      key,
      url: `https://${bucket}.s3.${config.s3Region}.amazonaws.com/${key}`,
    };
  }

  const dir = localDirFor(kind);
  const dest = path.join(dir, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return { backend: 'local', key, path: dest, url: pathToUrl(dest) };
}

/** Read an object back out as a Buffer, wherever it lives. */
export async function getObject(location) {
  if (location.backend === 's3') {
    const { GetObjectCommand, client } = await s3Client();
    const res = await client.send(
      new GetObjectCommand({ Bucket: location.bucket, Key: location.key })
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return fs.readFile(location.path);
}

function pathToUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/');
}

export const storageInfo = () => ({
  raw: usingS3('raw') ? `s3://${config.rawBucket}` : config.localRawDir,
  ready: usingS3('ready') ? `s3://${config.readyBucket}` : config.localReadyDir,
});
