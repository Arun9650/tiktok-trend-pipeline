import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';

// Optional human approval step for the repost pipeline (PRD open question:
// fully automated vs. an approval step before a post goes live — and the ToS/IP
// risk of reposting others' content makes a review gate the safe default).
//
// Mirrors the generation pipeline's telegramReview.js: each edited clip is sent
// to Telegram with Approve/Reject and the call resolves once you tap. If
// Telegram isn't configured or AUTO_APPROVE=true, it approves automatically so
// the pipeline still runs unattended in dev.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;
function getBot() {
  if (!bot) bot = new TelegramBot(BOT_TOKEN, { polling: true });
  return bot;
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Ask for approval of one edited clip before it's queued for posting.
 * Resolves true (approved) / false (rejected).
 */
export function requestRepostApproval(video) {
  // Skip the gate when approval is turned off, explicitly auto-approved, or
  // Telegram isn't wired up (dev/unattended). Otherwise wait for a human tap.
  if (!config.requireApproval || process.env.AUTO_APPROVE === 'true' || !BOT_TOKEN || !CHAT_ID) {
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    const b = getBot();
    const requestId = `repost-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const message = [
      `*Repost clip for review*`,
      ``,
      `*Source:* @${escapeMarkdown(video.sourceAccount || '?')} \\(${(video.plays || 0).toLocaleString()} plays\\)`,
      `*Original:* ${escapeMarkdown(video.webVideoUrl || 'n/a')}`,
      `*Burned caption:* ${escapeMarkdown(video.caption || '')}`,
      `*Trending sound:* ${escapeMarkdown(video.trendingSound?.name || 'keep original')}`,
      ``,
      `_Reposting others' content carries ToS/IP risk — approve only what's safe to post\\._`,
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
      const approved = query.data.startsWith('approve');
      b.sendMessage(CHAT_ID, approved ? 'Approved. Queued for posting.' : 'Rejected. Skipped.');
      resolve(approved);
    };
    b.on('callback_query', listener);
  });
}
