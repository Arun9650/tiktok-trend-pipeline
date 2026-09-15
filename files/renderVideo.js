import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const OUTPUT_DIR = './rendered-videos';
const APPROVED_DIR = './approved-scripts';

async function findLatestApprovedScript() {
  const files = await fs.readdir(APPROVED_DIR);
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error(`No approved scripts found in ${APPROVED_DIR}. Run the pipeline and approve one via Telegram first.`);
  }
  // Filenames are timestamp-prefixed (Date.now()-...), so a plain sort puts
  // the newest one last.
  jsonFiles.sort();
  return path.join(APPROVED_DIR, jsonFiles[jsonFiles.length - 1]);
}

async function main() {
  const scriptPath = process.argv[2] || (await findLatestApprovedScript());
  console.log(`Rendering from: ${scriptPath}`);

  const raw = await fs.readFile(scriptPath, 'utf-8');
  const { script } = JSON.parse(raw);

  if (!script) {
    throw new Error('That file has no "script" field, is this an approved-scripts JSON file?');
  }

  console.log('Bundling Remotion project (first run downloads a headless Chromium build, can take a few minutes)...');
  const bundleLocation = await bundle({
    entryPoint: path.resolve('./remotion/index.jsx'),
  });

  console.log('Selecting composition...');
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'ScriptVideo',
    inputProps: script,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${path.basename(scriptPath, '.json')}.mp4`);

  console.log('Rendering video...');
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: script,
  });

  console.log(`\nDone. Video saved to ${outputPath}`);
  console.log(
    'This video has background music baked in (remotion/public/background-audio.mp3). ' +
    'It does NOT include a copyrighted TikTok trending sound: the API doesn\'t support that anyway. ' +
    'Add the trending sound inside the TikTok app before you publish, same as any Upload to Inbox draft.'
  );
}

main().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
