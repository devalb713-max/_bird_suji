import 'dotenv/config';
import { Telegram } from 'telegraf';
import mongoose from 'mongoose';
import { connectDB, BotSettings } from './models/db.js';

function hasFlag(name) {
  return process.argv.includes(name);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

async function main() {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');

  const dryRun = hasFlag('--dry-run');
  const overrideChatId = getArg('--chat', null);

  await connectDB();
  const s = await BotSettings.findOne({}).lean().catch(() => null);
  const chatId = (overrideChatId || s?.reviewDumpChatId || '').toString().trim();
  if (!chatId) throw new Error('reviewDumpChatId not set (set it in Settings, or pass --chat <id>)');

  const telegram = new Telegram(process.env.BOT_TOKEN);
  const now = new Date();
  const msg =
    `<b>🧪 Review dump test</b>\n` +
    `<b>time</b>: <code>${now.toISOString()}</code>\n` +
    `<b>dumpChatId</b>: <code>${chatId}</code>\n\n` +
    `<blockquote>This is a test payload. If you see this, dump delivery works.</blockquote>\n\n` +
    `Try the buttons (they only work if your bot process is running):`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '✅ Approve (test)', callback_data: 'review_ok_TEST' },
        { text: '⛔ Decline (test)', callback_data: 'review_no_TEST' },
      ],
    ],
  };

  if (dryRun) {
    console.log(`[dry-run] would send to ${chatId}`);
    console.log(msg);
    return;
  }

  const sendOnce = async (toChatId) => {
    return telegram.sendMessage(toChatId, msg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup,
    });
  };

  try {
    const sent = await sendOnce(chatId);
    console.log(`✅ Sent test message to dump chat ${chatId} (message_id=${sent?.message_id || 'n/a'})`);
  } catch (err) {
    const migrateTo = err?.parameters?.migrate_to_chat_id;
    if (migrateTo) {
      const newId = migrateTo.toString();
      console.log(`⚠️ Dump chat migrated: ${chatId} -> ${newId}. Retrying...`);
      const sent = await sendOnce(newId);
      console.log(`✅ Sent test message to dump chat ${newId} (message_id=${sent?.message_id || 'n/a'})`);
      if (!overrideChatId) {
        await BotSettings.updateOne({}, { $set: { reviewDumpChatId: newId } }, { upsert: true }).catch(() => {});
        console.log(`✅ Updated BotSettings.reviewDumpChatId to ${newId}`);
      }
      return;
    }
    throw err;
  }
}

(() => {
  void (async () => {
    try {
      await main();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  })();
})();
