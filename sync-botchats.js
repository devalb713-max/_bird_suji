/**
 * One-shot sync script — joins all DB accounts into every bot-managed chat.
 * Unbans each account first (resolving userId via gramjs if not stored in DB),
 * creates a fresh invite link per account per chat, and retries on INVITE_HASH_EXPIRED.
 *
 * Run from the mega-forwarder directory:
 *   node mega-forwarder/sync-botchats.js
 */

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Api } from 'telegram/tl/index.js';
import { connectDB } from './models/db.js';
import { Account, BotChat } from './models/db.js';
import { createClient, extractInviteHash, isAuthError, isAccountBanned, isFloodError, getFloodSeconds, sleep } from './helpers/telegram.js';

await connectDB();

const bot = new Telegraf(process.env.BOT_TOKEN);

const [accounts, botChats] = await Promise.all([
  Account.find({ session: { $nin: [null, ''] } }),
  BotChat.find({}),
]);

if (!botChats.length) { console.log('No bot chats found.'); process.exit(0); }
if (!accounts.length) { console.log('No accounts with valid sessions.'); process.exit(0); }

const botChatIds = botChats.map(c => c.chatId);
console.log(`Found ${accounts.length} account(s) and ${botChats.length} bot chat(s).`);

// Create a fresh single-use invite link for a private chat, join with it, then revoke it.
async function joinViaFreshInvite(client, botChat, label) {
  let result;
  try {
    result = await bot.telegram.createChatInviteLink(Number(botChat.chatId), {
      creates_join_request: false,
      member_limit: 1,
    });
  } catch (err) {
    throw new Error(`Could not create invite for "${botChat.title}": ${err.message}`);
  }

  const link = result.invite_link;
  try {
    const hash = extractInviteHash(link);
    if (!hash) throw new Error('Could not extract invite hash');
    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    return { id: botChat.chatId, name: botChat.title, link };
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('USER_ALREADY_PARTICIPANT')) {
      return { id: botChat.chatId, name: botChat.title, link };
    }
    throw err;
  } finally {
    await bot.telegram.revokeChatInviteLink(Number(botChat.chatId), link).catch(() => {});
  }
}

// Join a chat (public via username, private via fresh invite).
// Returns groupInfo or throws.
async function joinChat(client, botChat, label) {
  if (botChat.username) {
    const entity = await client.getEntity(botChat.username);
    await client.invoke(new Api.channels.JoinChannel({ channel: entity })).catch(err => {
      if (!err.message?.includes('USER_ALREADY_PARTICIPANT')) throw err;
    });
    return { id: botChat.chatId, name: botChat.title, link: `https://t.me/${botChat.username}` };
  }
  return joinViaFreshInvite(client, botChat, label);
}

for (const account of accounts) {
  const label = account.username || account.number;
  console.log(`\n── Processing ${label} ──`);

  const client = createClient(account.session);

  try {
    await client.connect();

    // Resolve userId via gramjs if not stored
    let userId = account.userId;
    if (!userId) {
      const me = await client.getMe();
      userId = me.id?.toString();
      if (userId) {
        await Account.updateOne({ _id: account._id }, { userId });
        console.log(`  Resolved and stored userId: ${userId}`);
      }
    }

    // Step 1: Unban from all bot chats
    if (userId) {
      for (const botChat of botChats) {
        try {
          await bot.telegram.unbanChatMember(Number(botChat.chatId), Number(userId));
          console.log(`  Unbanned from "${botChat.title}"`);
        } catch (err) {
          if (!err.message?.includes('USER_NOT_BANNED') && !err.message?.includes('PARTICIPANT_ID_INVALID')) {
            console.log(`  Unban failed for "${botChat.title}": ${err.message}`);
          }
        }
        await sleep(500);
      }
    } else {
      console.log(`  Warning: could not resolve userId — skipping unban`);
    }

    // Step 2: Remove stale bot-chat entries so joins aren't skipped
    await Account.updateOne(
      { _id: account._id },
      { $pull: { groups: { id: { $in: botChatIds } } } }
    );

    // Step 3: Join each bot chat
    for (const botChat of botChats) {
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        try {
          const groupInfo = await joinChat(client, botChat, label);
          await Account.updateOne(
            { _id: account._id },
            { $addToSet: { groups: groupInfo } }
          );
          console.log(`  ✅ Joined "${botChat.title}"`);
          await sleep(8000 + Math.random() * 7000);
          break;
        } catch (err) {
          if (isAuthError(err)) throw err;

          if (isFloodError(err)) {
            const secs = getFloodSeconds(err);
            console.log(`  Flood wait ${secs}s for "${botChat.title}" — retrying after wait`);
            await sleep(secs * 1000);
            // loop retries
            continue;
          }

          const msg = err?.message || '';
          if (msg.includes('INVITE_HASH_EXPIRED') && attempts < 2) {
            console.log(`  Invite expired for "${botChat.title}" — creating fresh link and retrying`);
            // loop retries with a new link
            continue;
          }

          console.log(`  ❌ Could not join "${botChat.title}": ${msg}`);
          break;
        }
      }
    }

    await client.disconnect();
  } catch (err) {
    try { await client.disconnect(); } catch {}
    if (isAuthError(err)) {
      if (isAccountBanned(err)) {
        console.log(`  Account banned — deleting from DB`);
        await Account.deleteOne({ _id: account._id });
      } else {
        console.log(`  Session dead — suspending`);
        await Account.updateOne({ _id: account._id }, { session: null, isJoining: false, isMessaging: false });
      }
    } else {
      console.error(`  Error: ${err.message}`);
    }
  }

  await sleep(5000 + Math.random() * 5000);
}

console.log('\nDone.');
process.exit(0);
