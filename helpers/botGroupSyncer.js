import { Api } from 'telegram/tl/index.js';
import { Account, BotChat } from '../models/db.js';
import { createClient, extractInviteHash, isAuthError, isFloodError, getFloodSeconds, sleep } from './telegram.js';

let syncRunning = false;

// Create a fresh single-use invite link, join with it, then revoke.
async function joinViaFreshInvite(client, botChat, botTelegram) {
  let result;
  try {
    result = await botTelegram.createChatInviteLink(Number(botChat.chatId), {
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
    if (err?.message?.includes('USER_ALREADY_PARTICIPANT')) {
      return { id: botChat.chatId, name: botChat.title, link };
    }
    throw err;
  } finally {
    await botTelegram.revokeChatInviteLink(Number(botChat.chatId), link).catch(() => {});
  }
}

async function joinChat(client, botChat, botTelegram) {
  if (botChat.username) {
    const entity = await client.getEntity(botChat.username);
    await client.invoke(new Api.channels.JoinChannel({ channel: entity })).catch(err => {
      if (!err.message?.includes('USER_ALREADY_PARTICIPANT')) throw err;
    });
    return { id: botChat.chatId, name: botChat.title, link: `https://t.me/${botChat.username}` };
  }
  return joinViaFreshInvite(client, botChat, botTelegram);
}

export async function syncAccountsToBotChats(botTelegram) {
  if (syncRunning) return;
  syncRunning = true;

  try {
    const [accounts, botChats] = await Promise.all([
      Account.find({ session: { $nin: [null, ''] } }),
      BotChat.find({}),
    ]);

    if (!botChats.length || !accounts.length) return;

    const botChatIds = botChats.map(c => c.chatId);
    console.log(`[BotGroupSync] Syncing ${accounts.length} account(s) to ${botChats.length} bot chat(s)`);

    for (const account of accounts) {
      const label = account.username || account.number;
      const client = createClient(account.session, account._id);

      try {
        await client.connect();
        const refreshed = client.session.save();
        if (refreshed && refreshed !== account.session) {
          await Account.updateOne({ _id: account._id }, { session: refreshed });
        }

        // Resolve and store userId if missing
        let userId = account.userId;
        if (!userId) {
          const me = await client.getMe();
          userId = me.id?.toString();
          if (userId) await Account.updateOne({ _id: account._id }, { userId });
        }

        // Unban from all bot chats
        if (userId) {
          for (const botChat of botChats) {
            await botTelegram.unbanChatMember(Number(botChat.chatId), Number(userId)).catch(() => {});
            await sleep(300);
          }
        }

        // Remove stale bot-chat group entries so the join check doesn't skip them
        await Account.updateOne(
          { _id: account._id },
          { $pull: { groups: { id: { $in: botChatIds } } } }
        );

        for (const botChat of botChats) {
          let attempts = 0;
          while (attempts < 2) {
            attempts++;
            try {
              const groupInfo = await joinChat(client, botChat, botTelegram);
              await Account.updateOne({ _id: account._id }, { $addToSet: { groups: groupInfo } });
              console.log(`[BotGroupSync] ${label} joined "${botChat.title}"`);
              await sleep(8000 + Math.random() * 7000);
              break;
            } catch (err) {
              if (isAuthError(err)) throw err;
              if (isFloodError(err)) {
                const secs = getFloodSeconds(err);
                console.log(`[BotGroupSync] Flood wait ${secs}s for ${label}`);
                await sleep(secs * 1000);
                continue; // retry same chat
              }
              const msg = err?.message || '';
              if (msg.includes('INVITE_HASH_EXPIRED') && attempts < 2) {
                console.log(`[BotGroupSync] Invite expired for "${botChat.title}" — retrying with fresh link`);
                continue;
              }
              console.log(`[BotGroupSync] ${label} could not join "${botChat.title}": ${msg}`);
              break;
            }
          }
        }

        await client.disconnect();
      } catch (err) {
        try { await client.disconnect(); } catch {}
        if (isAuthError(err)) {
          console.log(`[BotGroupSync] ${label} auth error — skipping. Account and session preserved.`);
        } else {
          console.error(`[BotGroupSync] Error for ${label}:`, err.message);
        }
      }

      await sleep(5000 + Math.random() * 5000);
    }

    console.log('[BotGroupSync] Sync complete');
  } finally {
    syncRunning = false;
  }
}

export function startBotGroupSyncPoller(botTelegram, intervalMs = 15 * 60 * 1000) {
  setInterval(() => {
    syncAccountsToBotChats(botTelegram).catch(err =>
      console.error('[BotGroupSync] Poller error:', err.message)
    );
  }, intervalMs);
  console.log(`[BotGroupSync] Poller started (${intervalMs / 60000}m interval)`);
}
