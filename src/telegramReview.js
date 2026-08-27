import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;
function getBot() {
  if (!bot) {
    if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
  }
  return bot;
}

// Telegram's MarkdownV2 treats _ * [ ] ( ) ~ ` > # + - = | { } . ! as special
// characters and throws a parse error if any appear unescaped, e.g. a plain
// underscore in a TikTok handle/URL, or a hyphen in "A-Book/B-Book". Anything
// coming from the script or a video's own text/URL needs escaping before it
// goes into the message, static labels we write ourselves don't.
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Fire-and-forget plain-text message, no approval buttons and no polling
 * connection. Used by the scheduler to notify you a fetch+filter run
 * finished, separate from the interactive approve/reject flow above.
 */
export async function sendDigest(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: text.slice(0, 4000) }),
  });
  if (!res.ok) {
    console.error(`Telegram digest send failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Post a script to Telegram with Approve/Reject buttons and resolve once
 * you tap one. Each call waits for its own response, so if you queue up
 * several scripts they'll come through one at a time.
 */
export function requestApproval(script, trendGroup) {
  if (process.env.AUTO_APPROVE === 'true') return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const b = getBot();
    const requestId = `${Date.now()}`;

    const message = [
      `*New TikTok script for review*`,
      ``,
      `*Hook:* ${escapeMarkdown(script.hook)}`,
      `*Beats:*`,
      ...script.beats.map((beat, i) => `${i + 1}\\. ${escapeMarkdown(beat)}`),
      ``,
      `*CTA:* ${escapeMarkdown(script.cta)}`,
      ``,
      `*Caption:* ${escapeMarkdown(script.caption)}`,
      `*Hashtags:* ${escapeMarkdown(script.hashtags.join(' '))}`,
      `*Sound:* ${escapeMarkdown(trendGroup.soundName || 'unspecified')}`,
      `*Reference video:* ${escapeMarkdown(trendGroup.examples[0]?.webVideoUrl || 'n/a')}`,
    ].join('\n');

    const opts = {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${requestId}` },
            { text: '❌ Reject', callback_data: `reject:${requestId}` },
          ],
        ],
      },
    };

    b.sendMessage(CHAT_ID, message, opts).catch(reject);

    const listener = (query) => {
      if (!query.data.endsWith(requestId)) return;
      b.answerCallbackQuery(query.id);
      b.removeListener('callback_query', listener);

      if (query.data.startsWith('approve')) {
        b.sendMessage(CHAT_ID, 'Approved. Sending to render queue.');
        resolve(true);
      } else {
        b.sendMessage(CHAT_ID, 'Rejected. Skipping this one.');
        resolve(false);
      }
    };

    b.on('callback_query', listener);
  });
}

// Same approve/reject flow, but for Stitch/Duet reaction scripts. The message
// makes clear this isn't a standalone video, it's something to read out loud
// while recording a Stitch/Duet on the linked source video inside the app.
export function requestStitchApproval(stitchScript, sourceVideo) {
  if (process.env.AUTO_APPROVE === 'true') return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const b = getBot();
    const requestId = `stitch-${Date.now()}`;

    const message = [
      `*New Stitch/Duet script for review*`,
      ``,
      `*Source video to Stitch/Duet:* ${escapeMarkdown(sourceVideo.webVideoUrl)}`,
      `*Original caption:* "${escapeMarkdown(sourceVideo.text.slice(0, 150))}"`,
      `*Original share rate:* ${escapeMarkdown((sourceVideo.shareRatio * 100).toFixed(2))}%`,
      ``,
      `*Your reaction hook:* ${escapeMarkdown(stitchScript.reactionHook)}`,
      `*Commentary:*`,
      ...stitchScript.commentaryBeats.map((beat, i) => `${i + 1}\\. ${escapeMarkdown(beat)}`),
      ``,
      `*CTA:* ${escapeMarkdown(stitchScript.cta)}`,
      ``,
      `*Caption:* ${escapeMarkdown(stitchScript.caption)}`,
      `*Hashtags:* ${escapeMarkdown(stitchScript.hashtags.join(' '))}`,
      ``,
      `_To record: open the source video link, tap Stitch or Duet, then read the reaction above\\._`,
    ].join('\n');

    const opts = {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${requestId}` },
            { text: '❌ Reject', callback_data: `reject:${requestId}` },
          ],
        ],
      },
    };

    b.sendMessage(CHAT_ID, message, opts).catch(reject);

    const listener = (query) => {
      if (!query.data.endsWith(requestId)) return;
      b.answerCallbackQuery(query.id);
      b.removeListener('callback_query', listener);

      if (query.data.startsWith('approve')) {
        b.sendMessage(CHAT_ID, 'Approved. Saved for you to record.');
        resolve(true);
      } else {
        b.sendMessage(CHAT_ID, 'Rejected. Skipping this one.');
        resolve(false);
      }
    };

    b.on('callback_query', listener);
  });
}