import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram/tl/index.js';

(async () => {
  const session =
    process.env.SESSION_STRING ||
    process.env.SESSION ||
    process.argv[2] ||
    '';

  if (!session) {
    console.error('Missing session string. Set SESSION_STRING (or pass it as argv[2]).');
    process.exit(1);
  }

  const apiId = parseInt(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  if (!apiId || !apiHash) {
    console.error('Missing API_ID / API_HASH.');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    timeout: 30000,
    requestRetries: 3,
    autoReconnect: true,
  });
  client.setLogLevel('none');

  let lastEventAt = Date.now();
  let reconnecting = false;

  const shutdown = async (signal) => {
    try { console.log(`\n${signal} received, disconnecting...`); } catch {}
    try { await client.disconnect(); } catch {}
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.connect();
  const me = await client.getMe();
  await client.invoke(new Api.updates.GetState()).catch(() => {});
  await client.getDialogs({ limit: 20 }).catch(() => {});
  const meLabel = me?.username ? `@${me.username}` : (me?.id?.toString() || 'unknown');
  console.log(`Listening as ${meLabel}`);

  const reconnect = async (reason) => {
    if (reconnecting) return;
    reconnecting = true;
    console.log(JSON.stringify({ type: 'reconnect_start', reason, ts: new Date().toISOString() }));

    const backoffs = [1000, 3000, 7000, 15000, 30000];
    for (const waitMs of backoffs) {
      try {
        if (client.connected) await client.disconnect().catch(() => {});
        await new Promise((r) => setTimeout(r, waitMs));
        await client.connect();
        await client.getMe();
        await client.invoke(new Api.updates.GetState()).catch(() => {});
        await client.getDialogs({ limit: 20 }).catch(() => {});
        console.log(JSON.stringify({ type: 'reconnect_ok', ts: new Date().toISOString() }));
        reconnecting = false;
        return;
      } catch (err) {
        console.log(JSON.stringify({
          type: 'reconnect_fail',
          waitMs,
          error: err?.message || String(err),
          ts: new Date().toISOString(),
        }));
      }
    }

    reconnecting = false;
  };

  client.addEventHandler(async (update) => {
    if (update?.className === 'UpdateConnectionState') {
      console.log(JSON.stringify({
        type: 'connection_state',
        connected: !!client.connected,
        ts: new Date().toISOString(),
      }));
      if (!client.connected) reconnect('UpdateConnectionState');
    }
  });

  const buildMessageLink = async (message) => {
    try {
      const chat = await message.getChat();
      if (chat?.username) {
        return `https://t.me/${chat.username}/${message.id}`;
      }

      const chatIdStr = (message.chatId || chat?.id)?.toString?.() || '';
      if (chatIdStr.startsWith('-100')) {
        return `https://t.me/c/${chatIdStr.slice(4)}/${message.id}`;
      }
      if (chatIdStr.startsWith('-')) {
        return `https://t.me/c/${chatIdStr.slice(1)}/${message.id}`;
      }
      return null;
    } catch {
      return null;
    }
  };

  const buildGroupLink = async (message) => {
    try {
      const chat = await message.getChat();
      if (chat?.username) return `https://t.me/${chat.username}`;

      const chatIdStr = (message.chatId || chat?.id)?.toString?.() || '';
      if (chatIdStr.startsWith('-100')) return `https://t.me/c/${chatIdStr.slice(4)}`;
      return null;
    } catch {
      return null;
    }
  };

  const queue = [];
  let processing = false;

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        if (!item) continue;

        const { message } = item;
        const sender = await message.getSender().catch(() => null);
        const chat = await message.getChat().catch(() => null);

        const senderName = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || null;
        const senderUsername = sender?.username ? `@${sender.username}` : null;
        const senderId = sender?.id?.toString?.() || message.senderId?.toString?.() || null;

        const groupName =
          chat?.title ||
          (chat?.username ? `@${chat.username}` : null) ||
          (message.chatId || chat?.id)?.toString?.() ||
          null;
        const groupLink = await buildGroupLink(message);
        const messageLink = await buildMessageLink(message);

        const content = message.text || message.message || null;
        console.log(JSON.stringify({
          message: content || '[Media message]',
          senderName,
          senderUsername,
          senderId,
          groupName,
          groupLink,
          messageLink,
        }));
      }
    } catch (err) {
      console.log(JSON.stringify({
        type: 'processor_error',
        error: err?.message || String(err),
        ts: new Date().toISOString(),
      }));
    } finally {
      processing = false;
    }
  };

  client.addEventHandler(
    async (event) => {
      try {
        const message = event?.message;
        if (!message || message.out) return;
        if (!event.isGroup || event.isPrivate) return;

        lastEventAt = Date.now();
        queue.push({ message });
        processQueue().catch(() => {});
      } catch (err) {
        console.log(JSON.stringify({
          type: 'handler_error',
          error: err?.message || String(err),
          ts: new Date().toISOString(),
        }));
      }
    },
    new NewMessage({ incoming: true })
  );

  setInterval(async () => {
    try {
      if (!client.connected) return reconnect('keepalive_not_connected');
      await client.getMe();
      await client.invoke(new Api.updates.GetState()).catch(() => {});
      const idleMs = Date.now() - lastEventAt;
      if (idleMs > 2 * 60 * 1000) {
        await client.getDialogs({ limit: 20 }).catch(() => {});
      }
    } catch (err) {
      reconnect(err?.message || 'keepalive_error');
    }
  }, 30000);

  await new Promise(() => {});
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
