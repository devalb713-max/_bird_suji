import { TelegramClient } from 'telegram';
import { Logger } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { randomFingerprint, getAccountFingerprint } from './fingerprint.js';

// accountId: pass the DB account._id to pin a stable fingerprint per account.
// Omit (or null) for ephemeral clients (auth flow, one-shot fetches).
export function createClient(sessionString = '', accountId = null) {
  const fp = accountId ? getAccountFingerprint(accountId) : randomFingerprint();
  const baseLogger = new Logger('none');
  const client = new TelegramClient(
    new StringSession(sessionString),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 5,
      requestRetries: 3,
      autoReconnect: true,
      retryDelay: 1000,
      timeout: 30000,
      baseLogger,
      deviceModel: fp.deviceModel,
      systemVersion: fp.systemVersion,
      appVersion: fp.appVersion,
      langCode: fp.langCode,
      systemLangCode: fp.systemLangCode,
      userAgent: fp.userAgent,
      useIPv6: Math.random() < 0.3,
    }
  );
  client.setLogLevel('none');
  return client;
}

export function getDCAddress(dcId) {
  const dcMap = {
    1: '149.154.175.53',
    2: '149.154.167.51',
    3: '149.154.175.100',
    4: '149.154.167.91',
    5: '91.108.56.133',
  };
  return dcMap[dcId] || null;
}

export function extractUsernameFromLink(link = '') {
  if (!link) return null;
  let s = link.trim().replace(/^https?:\/\//i, '');
  s = s.replace(/^t\.me\//i, '').replace(/^telegram\.me\//i, '');
  return s.split('/')[0].split('?')[0].replace('@', '').trim() || null;
}

export function extractInviteHash(link = '') {
  if (!link) return null;
  const m1 = link.match(/t\.me\/\+([a-zA-Z0-9_-]+)/);
  if (m1?.[1]) return m1[1];
  const m2 = link.match(/t\.me\/joinchat\/([a-zA-Z0-9_-]+)/);
  if (m2?.[1]) return m2[1];
  return null;
}

export async function sendCodeWithRetry(client, phone, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: parseInt(process.env.API_ID),
          apiHash: process.env.API_HASH,
          settings: new Api.CodeSettings({
            allowFlashcall: true,
            currentNumber: true,
            allowAppHash: true,
            allowMissedCall: true,
          }),
        })
      );
      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      if (error.message?.startsWith('PHONE_MIGRATE_')) {
        const dcId = parseInt(error.message.split('_').pop(), 10);
        try {
          await client.disconnect();
          await sleep(2000);
          const fp = randomFingerprint();
          const newClient = new TelegramClient(new StringSession(''), parseInt(process.env.API_ID), process.env.API_HASH, {
            useWSS: false,
            autoReconnect: true,
            timeout: 30000,
            requestRetries: 3,
            connectionRetries: 5,
            retryDelay: 1000,
            initialServerAddress: getDCAddress(dcId),
            deviceModel: fp.deviceModel,
            systemVersion: fp.systemVersion,
            appVersion: fp.appVersion,
            langCode: fp.langCode,
            systemLangCode: fp.systemLangCode,
          });
          await newClient.connect();
          const result = await newClient.invoke(
            new Api.auth.SendCode({
              phoneNumber: phone,
              apiId: parseInt(process.env.API_ID),
              apiHash: process.env.API_HASH,
              settings: new Api.CodeSettings({
                allowFlashcall: true, currentNumber: true, allowAppHash: true,
                allowMissedCall: true,
              }),
            })
          );
          return { success: true, phoneCodeHash: result.phoneCodeHash, client: newClient };
        } catch (migErr) {
          if (attempt === maxRetries) return { success: false, error: migErr.message };
        }
      } else if (attempt === maxRetries) {
        return { success: false, error: error.message };
      }
      await sleep(2000 * attempt);
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

export async function loginWithCode(client, phoneNumber, phoneCodeHash, code) {
  try {
    await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }));
    return await _finalizeLogin(client, phoneNumber);
  } catch (err) {
    if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return { success: false, needsPassword: true };
    }
    try { await client.disconnect(); } catch {}
    return { success: false, error: err.message };
  }
}

export async function loginWith2FA(client, phoneNumber, password) {
  try {
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password.js');
    const hash = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: hash }));
    return await _finalizeLogin(client, phoneNumber);
  } catch (error) {
    if (error.errorMessage === 'PASSWORD_HASH_INVALID') {
      return { success: false, wrongPassword: true, error: 'Wrong password.' };
    }
    try { await client.disconnect(); } catch {}
    return { success: false, error: error.message };
  }
}

async function _finalizeLogin(client, phoneNumber) {
  const me = await client.getMe();
  const session = client.session.save();
  await client.disconnect();
  return { success: true, username: me.username || null, session, phoneNumber };
}

// Send photo with no caption, then immediately send text — no delays between them.
export async function sendPhotoThenMessage(client, peer, photo, text) {
  const photoFile = new CustomFile('photo.jpg', photo.length, '', photo);
  await client.sendFile(peer, { file: photoFile, forceDocument: false });
  await client.sendMessage(peer, { message: text });
}

// Send the group photo as a proper JPEG with the ad text as caption
export async function sendPhotoWithTyping(client, peer, photo, caption) {
  const wpm = 45;
  const words = caption.trim().split(/\s+/).length;
  const typingMs = Math.min((words / wpm) * 60000, 12000);
  const refreshEvery = 4500;

  await client.invoke(new Api.messages.SetTyping({
    peer,
    action: new Api.SendMessageUploadPhotoAction({ progress: 0 }),
  })).catch(() => {});

  const start = Date.now();
  while (Date.now() - start < typingMs - refreshEvery) {
    await sleep(refreshEvery);
    if (Date.now() - start < typingMs) {
      await client.invoke(new Api.messages.SetTyping({
        peer,
        action: new Api.SendMessageUploadPhotoAction({ progress: 50 }),
      })).catch(() => {});
    }
  }
  const rem = typingMs - (Date.now() - start);
  if (rem > 0) await sleep(rem);

  await sleep(2000 + Math.random() * 3000);

  const photoFile = new CustomFile('photo.jpg', photo.length, '', photo);
  return client.sendFile(peer, { file: photoFile, caption, forceDocument: false });
}

// Simulate realistic typing by sending typing action for the expected duration
export async function sendWithTyping(client, peer, text) {
  const wpm = 45;
  const words = text.trim().split(/\s+/).length;
  const typingMs = Math.min((words / wpm) * 60000, 12000);
  const refreshEvery = 4500;

  await client.invoke(new Api.messages.SetTyping({
    peer,
    action: new Api.SendMessageTypingAction(),
  })).catch(() => {});

  const start = Date.now();
  while (Date.now() - start < typingMs - refreshEvery) {
    await sleep(refreshEvery);
    if (Date.now() - start < typingMs) {
      await client.invoke(new Api.messages.SetTyping({
        peer,
        action: new Api.SendMessageTypingAction(),
      })).catch(() => {});
    }
  }
  const rem = typingMs - (Date.now() - start);
  if (rem > 0) await sleep(rem);

  // Pause before sending — simulates finishing typing before hitting send
  await sleep(2000 + Math.random() * 3000);

  return client.sendMessage(peer, { message: text });
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isFloodError(err) {
  if (err?.seconds != null) return true;
  const txt = err?.message || err?.errorMessage || '';
  return txt.includes('FLOOD_WAIT') || txt.includes('A wait of');
}

export function getFloodSeconds(err) {
  if (err?.seconds != null) return err.seconds;
  const txt = err?.message || err?.errorMessage || '';
  const m = txt.match(/FLOOD_WAIT_(\d+)/) || txt.match(/A wait of (\d+) seconds/);
  return m ? parseInt(m[1]) : 60;
}

export function isAuthError(err) {
  const msg = err?.message || err?.errorMessage || '';
  return msg.includes('AUTH_KEY_UNREGISTERED') ||
    msg.includes('SESSION_REVOKED') ||
    msg.includes('USER_DEACTIVATED') ||
    msg.includes('USER_DEACTIVATED_BAN') ||
    msg.includes('AUTH_KEY_INVALID') ||
    msg.includes('AUTH_KEY_DUPLICATED');
}

// Account permanently banned by Telegram — must be wiped from DB entirely
export function isAccountBanned(err) {
  const msg = err?.message || err?.errorMessage || '';
  return msg.includes('USER_DEACTIVATED_BAN') || msg.includes('USER_DEACTIVATED');
}

// Media-specific restriction — group allows text but not media.
// Caller should fall back to text-only instead of leaving the group.
export function isMediaForbiddenError(err) {
  const msg = err?.message || err?.errorMessage || '';
  return msg.includes('CHAT_SEND_MEDIA_FORBIDDEN') ||
    msg.includes('CHAT_SEND_PHOTOS_FORBIDDEN') ||
    msg.includes('CHAT_SEND_VIDEOS_FORBIDDEN') ||
    msg.includes('CHAT_SEND_GIFS_FORBIDDEN') ||
    msg.includes('CHAT_SEND_ROUNDVIDEOS_FORBIDDEN') ||
    msg.includes('CHAT_SEND_DOCUMENTS_FORBIDDEN');
}

// Full write ban — account can't post at all. Caller should leave the group.
export function isWriteForbidden(err) {
  const msg = err?.message || err?.errorMessage || '';
  return msg.includes('CHAT_WRITE_FORBIDDEN') ||
    msg.includes('CHAT_SEND_PLAIN_FORBIDDEN') ||       // text not allowed (media/sticker only group)
    msg.includes('CHAT_SEND_STICKERS_FORBIDDEN') ||
    msg.includes('CHAT_SEND_VOICES_FORBIDDEN') ||
    msg.includes('CHAT_ADMIN_REQUIRED') ||
    msg.includes('USER_BANNED_IN_CHANNEL') ||
    msg.includes('USER_RESTRICTED') ||
    msg.includes('BANNED_RIGHTS') ||
    msg.includes('RIGHT_FORBIDDEN') ||
    msg.includes('TOPIC_CLOSED') ||
    msg.includes('TOPIC_DELETED') ||
    msg.includes('CHAT_RESTRICTED') ||
    msg.includes('CHANNEL_PRIVATE') ||
    msg.includes('CHANNEL_INVALID') ||
    msg.includes('PEER_ID_INVALID');
}

export function isSlowmodeError(err) {
  const msg = err?.message || err?.errorMessage || '';
  return msg.includes('SLOWMODE_WAIT');
}

export function getSlowmodeSeconds(err) {
  const msg = err?.message || err?.errorMessage || '';
  const m = msg.match(/SLOWMODE_WAIT_(\d+)/);
  return m ? parseInt(m[1]) : 60;
}
