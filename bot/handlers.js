import { Markup } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { readFile } from 'node:fs/promises';
import {
  Account,
  Admin,
  Keyword,
  BotChat,
  ApprovedChat,
  BotSettings,
  BotUser,
  Payment,
  InviteTicket,
  MessageTemplate,
  QueuedPost,
  GroupLink,
} from '../models/db.js';
import { sendCodeWithRetry } from '../helpers/telegram.js';
import { randomFingerprint } from '../helpers/fingerprint.js';
import { startJoinWorker, stopJoinWorker, isJoinWorkerRunning, startPoller } from '../workers/joinWorker.js';
import { startMessageWorker, stopMessageWorker, isMessageWorkerRunning } from '../workers/messageWorker.js';
import { SEED_KEYWORDS } from '../models/keywords.js';

export async function isAdmin(userId, username) {
  await ensureAdminCacheLoaded();
  const id = userId?.toString();
  if (id && adminCache.userIds.has(id)) return true;
  if (username) {
    const u = '@' + username.replace(/^@/, '');
    if (adminCache.usernames.has(u)) return true;
  }
  return false;
}

async function requireAdmin(ctx) {
  if (await isAdmin(ctx.from.id, ctx.from.username)) return true;
  await ctx.reply('🚫 Not allowed.');
  return false;
}

const BILLING = (() => {
  const raw = (process.env.TESTMODE || '').toString().trim().toLowerCase();
  const testMode = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  const trialMs = testMode ? 10 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
  const monthMs = testMode ? 30 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const trialReminder8hMsBeforeEnd = testMode ? 6 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const trialReminder2hMsBeforeEnd = testMode ? 2 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const subReminder3dMsBeforeEnd = testMode ? 10 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
  return { testMode, trialMs, monthMs, trialReminder8hMsBeforeEnd, trialReminder2hMsBeforeEnd, subReminder3dMsBeforeEnd };
})();

const adminCache = {
  loaded: false,
  userIds: new Set(),
  usernames: new Set(),
};

async function refreshAdminCache() {
  const admins = await Admin.find({}).lean();
  adminCache.userIds = new Set(admins.map(a => a.userId).filter(Boolean));
  adminCache.usernames = new Set(admins.map(a => a.username).filter(Boolean));
  adminCache.loaded = true;
}

async function ensureAdminCacheLoaded() {
  if (adminCache.loaded) return;
  try {
    await refreshAdminCache();
  } catch {
    adminCache.loaded = true;
  }
}

const approvedChatCache = {
  loaded: false,
  groups: new Set(),
  channels: new Set(),
};

async function refreshApprovedChatCache() {
  const rows = await ApprovedChat.find({}).lean();
  const groups = new Set();
  const channels = new Set();
  for (const r of rows) {
    const id = r?.chatId?.toString?.() || null;
    if (!id) continue;
    const t = (r?.type || 'group').toString();
    if (t === 'channel') channels.add(id);
    else groups.add(id);
  }
  approvedChatCache.groups = groups;
  approvedChatCache.channels = channels;
  approvedChatCache.loaded = true;
}

async function ensureApprovedChatCacheLoaded() {
  if (approvedChatCache.loaded) return;
  try {
    await refreshApprovedChatCache();
  } catch {
    approvedChatCache.loaded = true;
  }
}

function describeTelegramError(err) {
  const code = err?.code ?? err?.response?.error_code;
  const desc = err?.description ?? err?.response?.description ?? err?.message ?? 'unknown_error';
  const retryAfter = err?.parameters?.retry_after ?? err?.response?.parameters?.retry_after ?? null;
  return { code, desc, retryAfter };
}

const kickFailNoticeAt = new Map();

function shouldNotifyKickFail(key, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const last = kickFailNoticeAt.get(key) || 0;
  if (last && (now - last) < windowMs) return false;
  kickFailNoticeAt.set(key, now);
  return true;
}

async function safeSendMessage(telegram, chatId, text, extra = null, context = '') {
  try {
    await telegram.sendMessage(chatId, text, extra || {});
    return true;
  } catch (err) {
    const { code, desc } = describeTelegramError(err);
    console.warn(`[sendMessage] ${context} chatId=${chatId} code=${code} desc=${desc}`);
    return false;
  }
}

async function notifyAdmins(telegram, text, context = 'admin_notice') {
  await ensureAdminCacheLoaded();
  const adminIds = Array.from(adminCache.userIds);
  for (const id of adminIds) {
    outboundQueue.enqueue(() => safeSendMessage(telegram, id, text, null, context));
  }
}

function pay100Keyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '💳 Pay 100 Stars', callback_data: 'subscribe_100' }]],
    },
  };
}

async function safeDeleteMessage(telegram, chatId, messageId, context = '') {
  if (!chatId || !messageId) return false;
  try {
    await telegram.deleteMessage(chatId, messageId);
    return true;
  } catch (err) {
    const { code, desc } = describeTelegramError(err);
    console.warn(`[deleteMessage] ${context} chatId=${chatId} msgId=${messageId} code=${code} desc=${desc}`);
    return false;
  }
}

async function safeCopyMessage(telegram, toChatId, fromChatId, messageId, extra = null, context = '') {
  const max = 2;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await telegram.copyMessage(toChatId, fromChatId, messageId, extra || {});
      return true;
    } catch (err) {
      const { code, desc, retryAfter } = describeTelegramError(err);
      if (retryAfter && attempt < max) {
        await new Promise(r => setTimeout(r, Number(retryAfter) * 1000));
        continue;
      }
      console.warn(`[copyMessage] ${context} to=${toChatId} from=${fromChatId} msgId=${messageId} code=${code} desc=${desc}`);
      return false;
    }
  }
  return false;
}

function createRateLimitedQueue(perSecond = 28) {
  const intervalMs = Math.max(10, Math.floor(1000 / perSecond));
  const queue = [];
  let timer = null;
  let active = false;
  let idleResolvers = [];

  const resolveIdleIfNeeded = () => {
    if (active || queue.length) return;
    const list = idleResolvers;
    idleResolvers = [];
    for (const r of list) r();
  };

  const tick = async () => {
    if (active) return;
    const job = queue.shift();
    if (!job) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      resolveIdleIfNeeded();
      return;
    }
    active = true;
    try {
      await job();
    } catch {}
    active = false;
    resolveIdleIfNeeded();
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => tick().catch(() => {}), intervalMs);
    tick().catch(() => {});
  };

  return {
    enqueue(fn) {
      queue.push(fn);
      start();
    },
    size() {
      return queue.length + (active ? 1 : 0);
    },
    onIdle() {
      if (!queue.length && !active) return Promise.resolve();
      return new Promise(r => idleResolvers.push(r));
    },
  };
}

const outboundQueue = createRateLimitedQueue(28);

const userSessions = new Map();
let authClient = null;

function getSession(userId) { return userSessions.get(userId.toString()); }
function setSession(userId, data) { userSessions.set(userId.toString(), data); }
function clearSession(userId) { userSessions.delete(userId.toString()); }

async function getSettings() {
  const existing = await BotSettings.findOne({});
  if (existing) return existing;
  return BotSettings.create({});
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Accounts', 'accounts')],
    [Markup.button.callback('➕ Add Account', 'add_account')],
    [Markup.button.callback('🧾 Templates', 'templates_menu')],
    [Markup.button.callback('🔑 Keywords', 'keywords_menu')],
    [Markup.button.callback('🔗 Group Links', 'grouplinks_menu')],
    [Markup.button.callback('🏷️ Authorized Groups', 'auth_groups')],
    [Markup.button.callback('� Authorized Channels', 'auth_channels')],
    [Markup.button.callback('� Broadcast', 'broadcast_menu')],
    [Markup.button.callback('⚙️ Settings', 'settings_menu')],
    [Markup.button.callback('👑 Admins', 'admins_menu')],
    [Markup.button.callback('▶️ Start All', 'start_all')],
    [Markup.button.callback('⏹️ Stop All', 'stop_all')],
  ]);
}

function backToMain() {
  return Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_to_main')]]);
}

function isGroupChatType(type) {
  return type === 'group' || type === 'supergroup';
}

function truncateLabel(s, max = 36) {
  const v = (s || '').toString().replace(/\s+/g, ' ').trim();
  if (v.length <= max) return v;
  return v.slice(0, max - 1) + '…';
}

async function approveChat(chatId, type = 'group', approvedBy = null) {
  await ApprovedChat.findOneAndUpdate(
    { chatId: chatId.toString() },
    { $set: { chatId: chatId.toString(), type, approvedBy: approvedBy ? approvedBy.toString() : null, approvedAt: new Date() } },
    { upsert: true }
  );
  if (type === 'channel') approvedChatCache.channels.add(chatId.toString());
  else approvedChatCache.groups.add(chatId.toString());
  approvedChatCache.loaded = true;
}

async function disapproveChat(chatId) {
  await ApprovedChat.deleteOne({ chatId: chatId.toString() });
  approvedChatCache.groups.delete(chatId.toString());
  approvedChatCache.channels.delete(chatId.toString());
  approvedChatCache.loaded = true;
}

async function authorizedGroupMiddleware(ctx, next) {
  const chat = ctx.chat;
  if (!chat || !isGroupChatType(chat.type)) return next();
  if (ctx.updateType !== 'message' && ctx.updateType !== 'callback_query') return next();

  await ensureApprovedChatCacheLoaded();
  const chatId = chat.id.toString();
  if (approvedChatCache.groups.has(chatId)) return next();

  const from = ctx.from;
  const isAdm = from ? await isAdmin(from.id, from.username) : false;

  const rawText = (ctx.message?.text || '').trim();
  const cmd = rawText ? rawText.split(/\s+/)[0].toLowerCase() : null;

  if (isAdm && cmd === '/approve') {
    await approveChat(chatId, 'group', from.id).catch(() => {});
    await safeSendMessage(ctx.telegram, from.id, `✅ Group approved: ${chat.title || chatId} (${chatId})`, null, 'approve_group');
    return;
  }
  if (isAdm && cmd === '/disapprove') {
    await disapproveChat(chatId).catch(() => {});
    await safeSendMessage(ctx.telegram, from.id, `⛔ Group disapproved: ${chat.title || chatId} (${chatId})`, null, 'disapprove_group');
    return;
  }

  return;
}

async function getMandatoryGroupIds() {
  await ensureApprovedChatCacheLoaded();
  return Array.from(approvedChatCache.groups);
}

async function getMandatoryChannelIds() {
  await ensureApprovedChatCacheLoaded();
  return Array.from(approvedChatCache.channels);
}

async function getMandatoryChatIds() {
  const [channels, groups] = await Promise.all([getMandatoryChannelIds(), getMandatoryGroupIds()]);
  return [...channels, ...groups];
}

async function getOperationalRoleCounts() {
  const rows = await Account.aggregate([
    { $match: { session: { $nin: [null, ''] } } },
    { $group: { _id: '$role', c: { $sum: 1 } } },
  ]);
  const map = Object.fromEntries(rows.map(r => [r._id, r.c]));
  return {
    listener: map.listener || 0,
    preacher: map.preacher || 0,
    finder: map.finder || 0,
  };
}

async function buildSetupStatsMessage(missingRoles = []) {
  const [
    roleCounts,
    templateCount,
    keywordCount,
    [approvedChannels, approvedGroups],
    inviterAccounts,
    usersTotal,
    usersBanned,
    usersPending,
    usersActiveTrial,
    usersActiveSub,
    paymentsTotal,
    settings,
  ] = await Promise.all([
    getOperationalRoleCounts(),
    MessageTemplate.countDocuments(),
    Keyword.countDocuments(),
    Promise.all([getMandatoryChannelIds(), getMandatoryGroupIds()]),
    Account.countDocuments({ role: 'inviter', session: { $nin: [null, ''] } }),
    BotUser.countDocuments({}),
    BotUser.countDocuments({ bannedAt: { $ne: null } }),
    BotUser.countDocuments({ pendingSubscriptionMonths: { $gt: 0 } }),
    BotUser.countDocuments({ trialEndsAt: { $gt: new Date() } }),
    BotUser.countDocuments({ subscriptionEndsAt: { $gt: new Date() } }),
    Payment.countDocuments({}),
    getSettings(),
  ]);

  const missingLine = missingRoles.length ? `Missing accounts: ${missingRoles.join(', ')}` : 'Missing accounts: none';

  const inviterSet = (settings?.inviterAccountIds?.length || settings?.inviterAccountId) ? 'yes' : 'no';
  const posting = settings?.botPostingEnabled ? 'on' : 'off';
  const aiAlerts = settings?.aiAlertsEnabled ? 'on' : 'off';

  return (
    `⚠️ Setup incomplete\n\n` +
    `${missingLine}\n\n` +
    `Accounts (logged in):\n` +
    `- listener: ${roleCounts.listener}\n` +
    `- preacher: ${roleCounts.preacher}\n` +
    `- group finder: ${roleCounts.finder}\n` +
    `- inviter: ${inviterAccounts}\n\n` +
    `Approved mandatory chats:\n` +
    `- channels: ${approvedChannels.length}\n` +
    `- groups: ${approvedGroups.length}\n\n` +
    `Content:\n` +
    `- templates: ${templateCount}\n` +
    `- keywords: ${keywordCount}\n\n` +
    `Users:\n` +
    `- total: ${usersTotal}\n` +
    `- active trial: ${usersActiveTrial}\n` +
    `- active subscription: ${usersActiveSub}\n` +
    `- pending activation: ${usersPending}\n` +
    `- banned: ${usersBanned}\n\n` +
    `Payments:\n` +
    `- records: ${paymentsTotal}\n\n` +
    `Settings:\n` +
    `- inviter account set: ${inviterSet}\n` +
    `- posting: ${posting}\n` +
    `- AI alerts: ${aiAlerts}`
  );
}

async function ensureOperationalPrereqs(ctx) {
  const counts = await getOperationalRoleCounts();
  const missing = [];
  if (counts.listener < 1) missing.push('listener');
  if (counts.preacher < 1) missing.push('preacher');
  if (counts.finder < 1) missing.push('group finder');
  if (!missing.length) return true;

  const msg = await buildSetupStatsMessage(missing);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('⚠️ Setup incomplete', { show_alert: true }).catch(() => {});
  }
  await ctx.reply(msg).catch(() => {});
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForQueueBelow(maxSize) {
  while (outboundQueue.size() > maxSize) {
    await sleep(250);
  }
}

export async function handleStart(ctx) {
  const isAdm = await isAdmin(ctx.from.id, ctx.from.username);
  if (!isAdm) return handleUserStart(ctx);

  const text = '👋 *Welcome to Sujini*\n\nUse the buttons below to manage accounts, groups, broadcasts, and settings:';
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...mainMenu() });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenu() });
  }
}

async function ensureBotUser(ctx) {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? '@' + ctx.from.username.replace(/^@/, '') : null;
  let isNew = false;
  let user = await BotUser.findOne({ userId });
  if (!user) {
    isNew = true;
    user = await BotUser.create({
      userId,
      username,
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + BILLING.trialMs),
    });
  } else if (username && user.username !== username) {
    await BotUser.updateOne({ _id: user._id }, { $set: { username } });
  }
  return { user, isNew };
}

async function isMember(telegram, chatId, userId) {
  try {
    const m = await telegram.getChatMember(chatId, userId);
    return m && m.status !== 'left' && m.status !== 'kicked';
  } catch {
    return false;
  }
}

function normalizeUsername(value = '') {
  const cleaned = (value || '').replace('@', '').trim().toLowerCase();
  return cleaned || null;
}

function extractUsernameFromLink(link = '') {
  if (!link) return null;
  try {
    const u = new URL(link);
    return normalizeUsername(u.pathname.replace(/^\//, '').split('/')[0]);
  } catch {
    const s = link.trim().replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^telegram\.me\//i, '');
    return normalizeUsername(s.split('/')[0].split('?')[0]);
  }
}

function extractChatIdCandidates(chatIdStr) {
  if (!chatIdStr) return [];
  if (!/^-?\d+$/.test(chatIdStr.toString())) return [];

  const raw = chatIdStr.toString();
  try {
    const base = BigInt(raw);
    const out = new Set();
    out.add(base);
    out.add(-base);

    if (raw.startsWith('-100')) {
      const inner = BigInt(raw.slice(4));
      out.add(inner);
      out.add(-inner);
      out.add(-1000000000000n - inner);
      out.add(-1000000000000n + inner);
    } else if (raw.startsWith('-')) {
      const inner = BigInt(raw.slice(1));
      out.add(inner);
      out.add(-inner);
      out.add(-1000000000000n - inner);
      out.add(-1000000000000n + inner);
    } else {
      out.add(-1000000000000n - base);
      out.add(-1000000000000n + base);
    }

    return Array.from(out);
  } catch {
    return [];
  }
}

async function getInviterAccount(settings) {
  const accounts = await getInviterAccounts(settings);
  return pickInviterAccount(accounts);
}

let inviterRotationIdx = 0;

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const s = v?.toString?.() || '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function pickInviterAccount(accounts) {
  if (!accounts?.length) return null;
  const idx = inviterRotationIdx % accounts.length;
  inviterRotationIdx += 1;
  return accounts[idx] || null;
}

async function getInviterAccounts(settings) {
  const ids = uniqStrings([...(settings?.inviterAccountIds || []), settings?.inviterAccountId].filter(Boolean));
  if (ids.length) {
    const accs = await Account.find({ _id: { $in: ids }, session: { $nin: [null, ''] } }).lean();
    const byId = new Map(accs.map(a => [a._id.toString(), a]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const fallback = await Account.find({ role: 'inviter', session: { $nin: [null, ''] } }).sort({ createdAt: 1 });
  return fallback || [];
}

async function resolveInviterPeer(client, chatIdStr, inviteLink) {
  const username = extractUsernameFromLink(inviteLink);
  if (username) {
    return client.getEntity(username);
  }

  const candidates = extractChatIdCandidates(chatIdStr);
  for (const c of candidates) {
    try {
      const entity = await client.getEntity(c);
      if (entity) return entity;
    } catch {}
  }

  throw new Error('peer_resolve_failed');
}

async function withInviterClient(inviterAcc, fn) {
  const fp = randomFingerprint();
  const client = new TelegramClient(
    new StringSession(inviterAcc.session),
    parseInt(process.env.API_ID),
    process.env.API_HASH,
    {
      connectionRetries: 5,
      requestRetries: 3,
      timeout: 30000,
      autoReconnect: true,
      deviceModel: fp.deviceModel,
      systemVersion: fp.systemVersion,
      appVersion: fp.appVersion,
      langCode: fp.langCode,
      systemLangCode: fp.systemLangCode,
      useIPv6: Math.random() < 0.3,
    }
  );
  client.setLogLevel('none');

  try {
    await client.connect();
    await client.getMe().catch(() => {});
    await client.getDialogs({ limit: 50 }).catch(() => {});
    return await fn(client);
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function createSingleUseInviteLink(inviterAcc, chatIdStr, inviteLink, title) {
  return withInviterClient(inviterAcc, async (client) => {
    const peer = await resolveInviterPeer(client, chatIdStr, inviteLink);
    const expireDate = Math.floor(Date.now() / 1000) + 60 * 60;
    const res = await client.invoke(new Api.messages.ExportChatInvite({
      peer,
      usageLimit: 1,
      expireDate,
      requestNeeded: false,
      title,
    }));
    return res?.link || null;
  });
}

async function revokeInviteLink(inviterAcc, chatIdStr, inviteLink, linkToRevoke) {
  return withInviterClient(inviterAcc, async (client) => {
    const peer = await resolveInviterPeer(client, chatIdStr, inviteLink);
    await client.invoke(new Api.messages.DeleteExportedChatInvite({ peer, link: linkToRevoke }));
    return true;
  });
}

async function ensureUserInviteTickets(settings, userId) {
  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return { channels: {}, groups: {} };

  const isStale = (t) => {
    const created = t?.createdAt ? new Date(t.createdAt).getTime() : 0;
    return created && (Date.now() - created) > 50 * 60 * 1000;
  };

  const out = { channels: {}, groups: {} };
  const channelIds = await getMandatoryChannelIds();
  const groupIds = await getMandatoryGroupIds();

  for (const channelId of channelIds) {
    const cid = channelId?.toString?.() || null;
    if (!cid) continue;
    const existing = await InviteTicket.findOne({ userId, chatId: cid, revokedAt: null }).lean();
    if (existing?.link && !isStale(existing)) {
      out.channels[cid] = existing.link;
      continue;
    }
    if (existing?.link && isStale(existing)) {
      await InviteTicket.updateOne({ userId, chatId: cid, link: existing.link, revokedAt: null }, { $set: { revokedAt: new Date() } }).catch(() => {});
    }
    let link = null;
    let inviterId = null;
    for (let i = 0; i < inviters.length; i += 1) {
      const inviter = pickInviterAccount(inviters);
      try {
        link = await createSingleUseInviteLink(inviter, cid, '', `user:${userId}:channel:${cid}`);
        if (link) {
          inviterId = inviter?._id?.toString?.() || null;
          break;
        }
      } catch {}
    }
    if (!link) continue;
    await InviteTicket.create({ userId, chatId: cid, link, inviterAccountId: inviterId });
    out.channels[cid] = link;
  }

  for (const groupId of groupIds) {
    const gid = groupId?.toString?.() || null;
    if (!gid) continue;
    const existing = await InviteTicket.findOne({ userId, chatId: gid, revokedAt: null }).lean();
    if (existing?.link && !isStale(existing)) {
      out.groups[gid] = existing.link;
      continue;
    }
    if (existing?.link && isStale(existing)) {
      await InviteTicket.updateOne({ userId, chatId: gid, link: existing.link, revokedAt: null }, { $set: { revokedAt: new Date() } }).catch(() => {});
    }

    let link = null;
    let inviterId = null;
    for (let i = 0; i < inviters.length; i += 1) {
      const inviter = pickInviterAccount(inviters);
      try {
        link = await createSingleUseInviteLink(inviter, gid, '', `user:${userId}:group:${gid}`);
        if (link) {
          inviterId = inviter?._id?.toString?.() || null;
          break;
        }
      } catch {}
    }
    if (!link) continue;
    await InviteTicket.create({ userId, chatId: gid, link, inviterAccountId: inviterId });
    out.groups[gid] = link;
  }

  return out;
}

async function revokeUserInviteTicketsForChat(settings, userId, chatIdStr) {
  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return;

  const tickets = await InviteTicket.find({ userId, chatId: chatIdStr.toString(), revokedAt: null }).lean();
  if (!tickets.length) return;

  for (const t of tickets) {
    const preferred = t?.inviterAccountId ? inviters.find(a => a._id?.toString?.() === t.inviterAccountId) : null;
    const order = preferred ? [preferred, ...inviters.filter(a => a !== preferred)] : inviters;
    for (const inviter of order) {
      try {
        await revokeInviteLink(inviter, chatIdStr.toString(), '', t.link);
        break;
      } catch {}
    }
    await InviteTicket.updateOne({ userId, chatId: chatIdStr.toString(), link: t.link, revokedAt: null }, { $set: { revokedAt: new Date() } }).catch(() => {});
  }
}

async function tryActivatePendingSubscription(settings, telegram, userId) {
  const u = await BotUser.findOne({ userId: userId.toString() });
  if (!u) return false;

  const months = u.pendingSubscriptionMonths || 0;
  if (months <= 0) return false;

  const channelIds = (await getMandatoryChannelIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  const groupIds = (await getMandatoryGroupIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));

  for (const cid of channelIds) {
    if (!(await isMember(telegram, cid, Number(userId)))) return false;
  }
  for (const gid of groupIds) {
    if (!(await isMember(telegram, gid, Number(userId)))) return false;
  }

  const currentEndMs = u.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).getTime() : 0;
  const baseMs = Math.max(Date.now(), currentEndMs);
  const newEnd = new Date(baseMs + months * BILLING.monthMs);
  await BotUser.updateOne(
    { _id: u._id },
    {
      $set: { subscriptionEndsAt: newEnd, removedAt: null, expiryReminder3dSentAt: null },
      $unset: { pendingSubscriptionPaidAt: '', pendingSubscriptionMonths: '' },
    }
  );

  for (const cid of channelIds) {
    await revokeUserInviteTicketsForChat(settings, userId.toString(), cid.toString()).catch(() => {});
  }
  for (const gid of groupIds) {
    await revokeUserInviteTicketsForChat(settings, userId.toString(), gid.toString()).catch(() => {});
  }

  await safeSendMessage(telegram, userId, `✅ Subscription activated. Access active until: ${newEnd.toUTCString()}`, null, 'activate_sub');
  return true;
}

function getFriendlyName(from) {
  const first = (from?.first_name || '').toString().trim();
  if (first) return first;
  const uname = (from?.username || '').toString().replace(/^@/, '').trim();
  if (uname) return '@' + uname;
  return 'friend';
}

async function isUserFacingOperational(settings) {
  const [counts, inviters, [channels, groups]] = await Promise.all([
    getOperationalRoleCounts(),
    getInviterAccounts(settings),
    Promise.all([getMandatoryChannelIds(), getMandatoryGroupIds()]),
  ]);

  if ((channels?.length || 0) + (groups?.length || 0) < 1) return false;
  if ((inviters?.length || 0) < 1) return false;
  if ((counts?.listener || 0) < 1) return false;
  if ((counts?.preacher || 0) < 1) return false;
  if ((counts?.finder || 0) < 1) return false;
  return true;
}

async function sendJoinPromptIfNeeded(ctx, settings, userDoc) {
  const requiredChannelIds = await getMandatoryChannelIds();
  const requiredGroupIds = await getMandatoryGroupIds();
  const firstChannelId = requiredChannelIds?.[0]?.toString?.() || null;
  const firstGroupId = requiredGroupIds?.[0]?.toString?.() || null;

  if (!firstChannelId && !firstGroupId) return false;
  if (userDoc?.joinPromptMessageId) return true;

  const invites = await ensureUserInviteTickets(settings, ctx.from.id.toString());
  const channelLink = firstChannelId ? invites.channels?.[firstChannelId] || null : null;
  const groupLink = firstGroupId ? invites.groups?.[firstGroupId] || null : null;

  const rows = [];
  if (groupLink) rows.push([Markup.button.url('Join Group', groupLink)]);
  if (channelLink) rows.push([Markup.button.url('Join Channel', channelLink)]);

  const text = 'Join our group and channel to get job updates and news about us.';
  const sent = await ctx.reply(text, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => null);
  if (!sent?.message_id) return false;

  await BotUser.updateOne(
    { _id: userDoc._id },
    { $set: { joinPromptMessageId: sent.message_id, joinPromptSentAt: new Date(), mandatoryJoinedAt: null } }
  ).catch(() => {});
  return true;
}

async function finalizeOnboardingIfJoined(settings, telegram, userIdStr) {
  const userId = userIdStr.toString();
  const u = await BotUser.findOne({ userId }).lean();
  if (!u) return false;
  if (u.mandatoryJoinedAt) return true;

  const channelIds = (await getMandatoryChannelIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  const groupIds = (await getMandatoryGroupIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));

  for (const cid of channelIds) {
    if (!(await isMember(telegram, cid, Number(userId)))) return false;
  }
  for (const gid of groupIds) {
    if (!(await isMember(telegram, gid, Number(userId)))) return false;
  }

  for (const cid of channelIds) {
    await revokeUserInviteTicketsForChat(settings, userId, cid.toString()).catch(() => {});
  }
  for (const gid of groupIds) {
    await revokeUserInviteTicketsForChat(settings, userId, gid.toString()).catch(() => {});
  }

  if (u.joinPromptMessageId) {
    await safeDeleteMessage(telegram, Number(userId), u.joinPromptMessageId, 'delete_join_prompt');
  }

  await BotUser.updateOne(
    { userId },
    { $set: { mandatoryJoinedAt: new Date(), joinPromptMessageId: null, joinPromptSentAt: null } }
  ).catch(() => {});

  const now = Date.now();
  const trialEndsAt = u.trialEndsAt ? new Date(u.trialEndsAt).getTime() : 0;
  const subEndsAt = u.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).getTime() : 0;
  const pendingMonths = u.pendingSubscriptionMonths || 0;

  if (pendingMonths > 0) {
    await safeSendMessage(telegram, userId, '✅ Payment received. Subscription will activate after join verification.', null, 'joined_pending_notice');
    return true;
  }

  if (trialEndsAt && now < trialEndsAt) {
    await safeSendMessage(
      telegram,
      userId,
      `✅ Trial started.\nAccess active until: ${new Date(trialEndsAt).toUTCString()}\n\nYou’ll get a reminder before it expires with a Pay button.`,
      null,
      'trial_started_notice'
    );
    return true;
  }

  if (subEndsAt && now < subEndsAt) {
    await safeSendMessage(
      telegram,
      userId,
      `✅ Subscription active.\nAccess active until: ${new Date(subEndsAt).toUTCString()}`,
      null,
      'sub_active_notice'
    );
    return true;
  }

  await safeSendMessage(telegram, userId, 'Access is inactive. You will receive a Pay button on expiry notifications.', null, 'inactive_notice');
  return true;
}

async function handleUserStart(ctx) {
  const settings = await getSettings();
  if (!(await isUserFacingOperational(settings))) {
    const name = getFriendlyName(ctx.from);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Under maintenance', { show_alert: true }).catch(() => {});
    }
    await ctx.reply(`Hey ${name}, Sujini bot is currently under maintenance. Please try again later.`).catch(() => {});
    return;
  }

  const { user, isNew } = await ensureBotUser(ctx);
  if (user?.bannedAt) {
    await safeSendMessage(ctx.telegram, ctx.from.id, '🚫 You are banned from using this bot.', null, 'banned_user');
    return;
  }
  await tryActivatePendingSubscription(settings, ctx.telegram, ctx.from.id).catch(() => {});

  const now = Date.now();
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0;
  const subEndsAt = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt).getTime() : 0;
  const hasTimeAccess = now < trialEndsAt || now < subEndsAt;

  const requiredChannelIds = (await getMandatoryChannelIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  const requiredGroupIds = (await getMandatoryGroupIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));

  const missing = [];
  let hasAllMembership = true;
  for (const cid of requiredChannelIds) {
    const ok = await isMember(ctx.telegram, cid, ctx.from.id);
    if (!ok) { missing.push({ kind: 'channel', chatId: cid.toString() }); hasAllMembership = false; }
  }
  for (const gid of requiredGroupIds) {
    const ok = await isMember(ctx.telegram, gid, ctx.from.id);
    if (!ok) { missing.push({ kind: 'group', chatId: gid.toString() }); hasAllMembership = false; }
  }

  if (missing.length) {
    const name = getFriendlyName(ctx.from);
    if (isNew) {
      await ctx.reply(`Hey ${name}, welcome to Sujini bot.`).catch(() => {});
    }
    await sendJoinPromptIfNeeded(ctx, settings, user);
    return;
  }

  if (!user.mandatoryJoinedAt) {
    await finalizeOnboardingIfJoined(settings, ctx.telegram, ctx.from.id.toString()).catch(() => {});
    return;
  }

  const active = hasTimeAccess && hasAllMembership;
  const ends = now < trialEndsAt ? new Date(trialEndsAt) : new Date(subEndsAt);
  const text = active
    ? `✅ Access active until: ${ends.toUTCString()}`
    : 'Access inactive. You will receive a Pay button on expiry notifications.';

  await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('✅ Refresh', 'user_refresh')]])).catch(() => {});
}

export async function handleAdminsMenu(ctx) {
  const admins = await Admin.find({}).sort({ createdAt: 1 });
  let text = `👑 *Admins* (${admins.length})\n\n`;
  admins.forEach((a, i) => {
    text += `${i + 1}. ${a.username || ''} ${a.userId ? `(${a.userId})` : ''}\n`;
  });

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Admin', 'add_admin')],
      [Markup.button.callback('🗑️ Remove Admin', 'remove_admin_list')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

export async function handleAddAdmin(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_admin_id', data: {} });
  await ctx.editMessageText(
    '👑 *Add Admin*\n\nSend their Telegram user ID or @username:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'admins_menu')]]) }
  );
  await ctx.answerCbQuery();
}

export async function handleAdminIdInput(ctx) {
  const raw = ctx.message.text.trim();
  clearSession(ctx.from.id);

  const isUserId = /^\d+$/.test(raw);
  const doc = isUserId
    ? { userId: raw }
    : { username: '@' + raw.replace(/^@/, '') };

  try {
    await Admin.create(doc);
    await refreshAdminCache().catch(() => {});
    await ctx.reply(`✅ Admin added: ${raw}\n\nUse the menu below to continue.`, mainMenu());
  } catch {
    await ctx.reply('⚠️ Already an admin or invalid input.\n\nUse the menu below to continue.', mainMenu());
  }
}

export async function handleRemoveAdminList(ctx) {
  const admins = await Admin.find({});
  if (!admins.length) {
    await ctx.answerCbQuery('No admins to remove');
    return handleAdminsMenu(ctx);
  }
  const buttons = admins.map(a => [
    Markup.button.callback(`🗑️ ${a.username || a.userId}`, `del_admin_${a._id}`),
  ]);
  buttons.push([Markup.button.callback('« Back', 'admins_menu')]);
  await ctx.editMessageText('Select an admin below to remove them:', Markup.inlineKeyboard(buttons));
  await ctx.answerCbQuery();
}

export async function handleDeleteAdmin(ctx, adminId) {
  const count = await Admin.countDocuments();
  if (count <= 1) return ctx.answerCbQuery('⚠️ Cannot remove the last admin');
  await Admin.deleteOne({ _id: adminId });
  await refreshAdminCache().catch(() => {});
  await ctx.answerCbQuery('🗑️ Admin removed');
  return handleAdminsMenu(ctx);
}

export async function handleAccounts(ctx) {
  const accounts = await Account.find({}).sort({ createdAt: 1 });
  if (!accounts.length) {
    await ctx.editMessageText('No accounts yet. Add an account from the main menu to begin.', backToMain());
    return ctx.answerCbQuery();
  }
  const buttons = accounts.map((acc, i) => {
    const label = `${i + 1}. ${acc.username ? '@' + acc.username : acc.number} (${acc.role})`;
    return [Markup.button.callback(label, `acc_${acc._id}`)];
  });
  buttons.push([Markup.button.callback('« Back', 'back_to_main')]);
  await ctx.editMessageText('📋 *Accounts*\n\nSelect an account below to manage it:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
}

export async function handleAccountDetail(ctx, accId) {
  const acc = await Account.findById(accId);
  if (!acc) { await ctx.answerCbQuery('Not found'); return handleAccounts(ctx); }

  const joining = isJoinWorkerRunning(acc._id);
  const messaging = isMessageWorkerRunning(acc._id);
  const limitInfo = acc.searchLimitHit
    ? `\n⚠️ Search limit resets: ${acc.searchLimitResetsAt?.toUTCString() || 'unknown'}`
    : '';

  const text =
    `*${acc.username ? '@' + acc.username : acc.number}*\n` +
    `Role: *${acc.role}*\n` +
    `Groups joined: *${acc.groups.length}*${limitInfo}\n` +
    `Join/Search: ${joining ? '✅ Running' : '⏹️ Stopped'}\n` +
    `Listen/Preach: ${messaging ? '✅ Running' : '⏹️ Stopped'}`;

  const joinBtn = joining
    ? Markup.button.callback('⏹️ Stop Join/Search', `stop_join_${acc._id}`)
    : Markup.button.callback('▶️ Start Join/Search', `start_join_${acc._id}`);
  const msgBtn = messaging
    ? Markup.button.callback('⏹️ Stop Listen/Preach', `stop_msg_${acc._id}`)
    : Markup.button.callback('▶️ Start Listen/Preach', `start_msg_${acc._id}`);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [joinBtn],
      [msgBtn],
      [Markup.button.callback('🚪 Logout Account', `logout_${acc._id}`)],
      [Markup.button.callback('« Back', 'accounts')],
    ]),
  });
  await ctx.answerCbQuery();
}

export async function handleLogout(ctx, accId) {
  await stopJoinWorker(accId);
  await stopMessageWorker(accId);
  await Account.deleteOne({ _id: accId });
  await ctx.answerCbQuery('Account removed');
  return handleAccounts(ctx);
}

export async function handleAddAccount(ctx) {
  if (!(await requireAdmin(ctx))) return;
  setSession(ctx.from.id, { step: 'awaiting_account_role', data: {} });
  const rows = await Account.aggregate([{ $group: { _id: '$role', c: { $sum: 1 } } }]);
  const map = Object.fromEntries(rows.map(r => [r._id, r.c]));
  const cListener = map.listener || 0;
  const cPreacher = map.preacher || 0;
  const cFinder = map.finder || 0;
  const cInviter = map.inviter || 0;
  await ctx.editMessageText(
    '📱 *Add Account*\n\nSelect the account type:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`👂 Listener (${cListener})`, 'pick_role_listener')],
        [Markup.button.callback(`📣 Preacher (${cPreacher})`, 'pick_role_preacher')],
        [Markup.button.callback(`🔎 Group Finder (${cFinder})`, 'pick_role_finder')],
        [Markup.button.callback(`🧷 Inviter (${cInviter})`, 'pick_role_inviter')],
        [Markup.button.callback('« Cancel', 'back_to_main')],
      ]),
    }
  );
  await ctx.answerCbQuery();
}

export async function handlePickAccountRole(ctx, role) {
  const session = getSession(ctx.from.id) || { step: null, data: {} };
  session.data.role = role;
  session.step = 'awaiting_number';
  setSession(ctx.from.id, session);
  await ctx.editMessageText(
    'Send the phone number (with country code):\nExample: +1234567890',
    { ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]) }
  );
  await ctx.answerCbQuery();
}

export async function handlePhoneNumber(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const phone = ctx.message.text.trim();

  const existing = await Account.findOne({ number: phone });
  if (existing?.session) {
    clearSession(ctx.from.id);
    return ctx.reply(
      `⚠️ This Telegram account is already logged in as *${existing.role}* (${existing.username ? '@' + existing.username : existing.number}).\n\n` +
        `It cannot be logged in again under another role. Remove it first if you really need to change its role.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }
  if (existing) {
    clearSession(ctx.from.id);
    return ctx.reply(
      `⚠️ This Telegram account is already added (${existing.role}).\n\nUse *Accounts* to manage it.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }

  await ctx.reply('⏳ Sending verification code...');

  const fp = randomFingerprint();
  authClient = new TelegramClient(new StringSession(''), parseInt(process.env.API_ID), process.env.API_HASH, {
    useWSS: false, autoReconnect: true, timeout: 30000,
    requestRetries: 3, connectionRetries: 5,
    deviceModel: fp.deviceModel, systemVersion: fp.systemVersion,
    appVersion: fp.appVersion, langCode: fp.langCode, systemLangCode: fp.systemLangCode,
  });

  try {
    await authClient.connect();
    const result = await sendCodeWithRetry(authClient, phone);
    if (!result.success) throw new Error(result.error);

    authClient = result.client || authClient;
    session.data = { ...session.data, phoneNumber: phone, phoneCodeHash: result.phoneCodeHash };
    session.step = 'awaiting_code';
    setSession(ctx.from.id, session);

    await ctx.reply('🔐 Code sent! Enter the verification code:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
  } catch (err) {
    clearSession(ctx.from.id);
    try { await authClient?.disconnect(); } catch {}
    authClient = null;
    await ctx.reply(`❌ Failed: ${err.message}`, mainMenu());
  }
}

export async function handleVerificationCode(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const code = ctx.message.text.trim();
  const { phoneNumber, phoneCodeHash } = session.data;
  if (!authClient) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', mainMenu()); }

  await ctx.reply('⏳ Logging in...');
  if (!authClient.connected) await authClient.connect();

  try {
    await authClient.invoke(new Api.auth.SignIn({
      phoneNumber,
      phoneCodeHash,
      phoneCode: code,
    }));
    await _saveNewAccount(ctx, phoneNumber);
  } catch (err) {
    if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      session.step = 'awaiting_password';
      setSession(ctx.from.id, session);
      return ctx.reply('🔒 2FA enabled. Send your password:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
    }
    clearSession(ctx.from.id);
    try { await authClient?.disconnect(); } catch {}
    authClient = null;
    return ctx.reply(`❌ Login failed: ${err.message}`, mainMenu());
  }
}

export async function handlePassword(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const password = ctx.message.text.trim();
  const { phoneNumber } = session.data;
  if (!authClient) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', mainMenu()); }

  await ctx.reply('⏳ Verifying password...');
  if (!authClient.connected) await authClient.connect();

  try {
    const passwordInfo = await authClient.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password.js');
    const passwordHash = await computeCheck(passwordInfo, password);
    await authClient.invoke(new Api.auth.CheckPassword({ password: passwordHash }));
    await _saveNewAccount(ctx, phoneNumber);
  } catch (err) {
    if (err.errorMessage === 'PASSWORD_HASH_INVALID') {
      return ctx.reply('❌ Wrong password. Try again:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
    }
    clearSession(ctx.from.id);
    try { await authClient?.disconnect(); } catch {}
    authClient = null;
    return ctx.reply(`❌ Login failed: ${err.message}`, mainMenu());
  }
}

async function _saveNewAccount(ctx, phoneNumber) {
  const session = getSession(ctx.from.id);
  const role = session?.data?.role || 'listener';
  clearSession(ctx.from.id);

  const me = await authClient.getMe();
  const sessionString = authClient.session.save();
  await authClient.disconnect();
  authClient = null;

  const existing = await Account.findOne({ number: phoneNumber });
  if (existing?.session) {
    return ctx.reply(
      `⚠️ This Telegram account is already logged in as *${existing.role}* (${existing.username ? '@' + existing.username : existing.number}).\n\n` +
        `It cannot be logged in again under another role. Remove it first if you really need to change its role.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }
  if (existing) {
    return ctx.reply(
      `⚠️ This Telegram account is already added (${existing.role}).\n\nUse *Accounts* to manage it.`,
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  }
  await Account.create({
    number: phoneNumber,
    username: me.username || null,
    userId: me.id?.toString() || null,
    session: sessionString,
    role,
    groups: [],
    isJoining: false,
    isMessaging: false,
  });

  await ctx.reply(
    `✅ *Account added!*\nType: *${role}*\nUsername: ${me.username ? '@' + me.username : 'N/A'}\nPhone: ${phoneNumber}`,
    { parse_mode: 'Markdown', ...mainMenu() }
  );
}

export async function handleTemplatesMenu(ctx) {
  const count = await MessageTemplate.countDocuments();
  await ctx.editMessageText(
    `🧾 *Templates* (${count})`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Template', 'template_add')],
        [Markup.button.callback('📋 View Templates', 'template_view')],
        [Markup.button.callback('« Back', 'back_to_main')],
      ]),
    }
  );
  await ctx.answerCbQuery();
}

export async function handleAddTemplate(ctx) {
  if (!(await requireAdmin(ctx))) return;
  setSession(ctx.from.id, { step: 'awaiting_template_text', data: {} });
  await ctx.editMessageText(
    'Send the template text:',
    { ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'templates_menu')]]) }
  );
  await ctx.answerCbQuery();
}

export async function handleTemplateTextInput(ctx) {
  const text = ctx.message.text.trim();
  clearSession(ctx.from.id);
  if (!text) return ctx.reply('⚠️ Empty template ignored.', mainMenu());
  await MessageTemplate.create({ text });
  await ctx.reply('✅ Template saved.\n\nUse the menu below to continue.', mainMenu());
}

export async function handleViewTemplates(ctx) {
  const templates = await MessageTemplate.find({}).sort({ createdAt: -1 }).limit(25);
  if (!templates.length) {
    await ctx.editMessageText('No templates yet. Add one, then come back here to manage them.', Markup.inlineKeyboard([[Markup.button.callback('« Back', 'templates_menu')]]));
    return ctx.answerCbQuery();
  }
  const buttons = templates.map(t => [Markup.button.callback(`🗑️ ${t.text.slice(0, 40) || '(empty)'}`, `del_tpl_${t._id}`)]);
  buttons.push([Markup.button.callback('« Back', 'templates_menu')]);
  await ctx.editMessageText('Tap a template below to delete it:', Markup.inlineKeyboard(buttons));
  await ctx.answerCbQuery();
}

export async function handleDeleteTemplate(ctx, id) {
  await MessageTemplate.deleteOne({ _id: id });
  await ctx.answerCbQuery('🗑️ Deleted');
  return handleViewTemplates(ctx);
}

const KW_PAGE = 10;

export async function handleKeywordsMenu(ctx) {
  const count = await Keyword.countDocuments();
  await ctx.editMessageText(
    `🔑 *Keywords* (${count} total)`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Keywords', 'add_keywords')],
        [Markup.button.callback('📋 View Keywords', 'view_keywords_0')],
        [Markup.button.callback('« Back', 'back_to_main')],
      ]),
    }
  );
  await ctx.answerCbQuery();
}

export async function handleAddKeywords(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_keywords', data: {} });
  await ctx.editMessageText(
    '➕ *Add Keywords*\n\nSend keywords separated by commas, or spaces if no commas:\nExample: `react, node, python`',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'keywords_menu')]]) }
  );
  await ctx.answerCbQuery();
}

export async function handleKeywordsInput(ctx) {
  const raw = ctx.message.text.trim();
  const words = raw.includes(',')
    ? raw.split(',').map(w => w.trim()).filter(Boolean)
    : raw.split(/\s+/).filter(Boolean);

  let added = 0;
  for (const w of words) {
    try { await Keyword.create({ word: w.toLowerCase() }); added++; } catch {}
  }
  clearSession(ctx.from.id);
  await ctx.reply(`✅ Added ${added}/${words.length} keywords (duplicates skipped).`, mainMenu());
}

export async function handleViewKeywords(ctx, page = 0) {
  const total = await Keyword.countDocuments();
  if (!total) {
    await ctx.editMessageText('No keywords yet. Add a few, then come back here to manage them.', Markup.inlineKeyboard([[Markup.button.callback('« Back', 'keywords_menu')]]));
    return ctx.answerCbQuery();
  }
  const keywords = await Keyword.find({}).sort({ createdAt: 1 }).skip(page * KW_PAGE).limit(KW_PAGE);
  const totalPages = Math.ceil(total / KW_PAGE);

  const buttons = keywords.map(k => [Markup.button.callback(`🗑️ ${k.word}`, `del_kw_${k._id}`)]);
  if (page > 0) buttons.push([Markup.button.callback('⬅️ Prev', `view_keywords_${page - 1}`)]);
  if (page < totalPages - 1) buttons.push([Markup.button.callback('Next ➡️', `view_keywords_${page + 1}`)]);
  buttons.push([Markup.button.callback('« Back', 'keywords_menu')]);

  await ctx.editMessageText(
    `🔑 *Keywords* (page ${page + 1}/${totalPages}, total ${total})\n_Click a keyword to delete it_`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
  await ctx.answerCbQuery();
}

export async function handleDeleteKeyword(ctx, kwId) {
  await Keyword.deleteOne({ _id: kwId });
  await ctx.answerCbQuery('🗑️ Deleted');
  return handleViewKeywords(ctx, 0);
}

const AUTH_CHAT_PAGE = 8;

export async function handleAuthGroupsMenu(ctx, page = 0) {
  if (!(await requireAdmin(ctx))) return;
  await ensureApprovedChatCacheLoaded();

  const query = { type: { $in: ['group', 'supergroup'] } };
  const total = await BotChat.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / AUTH_CHAT_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const chats = await BotChat.find(query)
    .sort({ updatedAt: -1 })
    .skip(safePage * AUTH_CHAT_PAGE)
    .limit(AUTH_CHAT_PAGE)
    .lean();

  const buttons = chats.map(c => {
    const approved = approvedChatCache.groups.has(c.chatId);
    const label = `${approved ? '✅' : '⛔'} ${truncateLabel(c.title)} (${c.chatId})`;
    return [Markup.button.callback(label, `toggle_auth_${c.chatId}`)];
  });

  if (safePage > 0) buttons.push([Markup.button.callback('⬅️ Prev', `auth_groups_page_${safePage - 1}`)]);
  if (safePage < totalPages - 1) buttons.push([Markup.button.callback('Next ➡️', `auth_groups_page_${safePage + 1}`)]);
  buttons.push([Markup.button.callback('« Back', 'back_to_main')]);

  const text =
    `🏷️ *Authorized Groups*\n\n` +
    `Approved groups can use the bot.\n` +
    `Admins can also /approve or /disapprove inside a group.\n\n` +
    `Known groups: *${total}* (page ${safePage + 1}/${totalPages})`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
}

export async function handleToggleAuthChat(ctx, chatId) {
  if (!(await requireAdmin(ctx))) return;
  await ensureApprovedChatCacheLoaded();

  const id = chatId.toString();
  const approved = approvedChatCache.groups.has(id);
  if (approved) {
    await disapproveChat(id).catch(() => {});
    await ctx.answerCbQuery('⛔ Disapproved');
  } else {
    await approveChat(id, 'group', ctx.from.id).catch(() => {});
    await ctx.answerCbQuery('✅ Approved');
  }
  return handleAuthGroupsMenu(ctx, 0);
}

export async function handleAuthChannelsMenu(ctx, page = 0) {
  if (!(await requireAdmin(ctx))) return;
  await ensureApprovedChatCacheLoaded();

  const query = { type: 'channel' };
  const total = await BotChat.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / AUTH_CHAT_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const chats = await BotChat.find(query)
    .sort({ updatedAt: -1 })
    .skip(safePage * AUTH_CHAT_PAGE)
    .limit(AUTH_CHAT_PAGE)
    .lean();

  const buttons = chats.map(c => {
    const approved = approvedChatCache.channels.has(c.chatId);
    const label = `${approved ? '✅' : '⛔'} ${truncateLabel(c.title)} (${c.chatId})`;
    return [Markup.button.callback(label, `toggle_auth_ch_${c.chatId}`)];
  });

  if (safePage > 0) buttons.push([Markup.button.callback('⬅️ Prev', `auth_channels_page_${safePage - 1}`)]);
  if (safePage < totalPages - 1) buttons.push([Markup.button.callback('Next ➡️', `auth_channels_page_${safePage + 1}`)]);
  buttons.push([Markup.button.callback('« Back', 'back_to_main')]);

  const text =
    `📺 *Authorized Channels*\n\n` +
    `Approved channels are mandatory for user access.\n\n` +
    `Known channels: *${total}* (page ${safePage + 1}/${totalPages})`;

  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
}

export async function handleToggleAuthChannel(ctx, chatId) {
  if (!(await requireAdmin(ctx))) return;
  await ensureApprovedChatCacheLoaded();

  const id = chatId.toString();
  const approved = approvedChatCache.channels.has(id);
  if (approved) {
    await disapproveChat(id).catch(() => {});
    await ctx.answerCbQuery('⛔ Disapproved');
  } else {
    await approveChat(id, 'channel', ctx.from.id).catch(() => {});
    await ctx.answerCbQuery('✅ Approved');
  }
  return handleAuthChannelsMenu(ctx, 0);
}

export async function handleBroadcastMenu(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text =
    `📣 *Broadcast*\n\n` +
    `Send one message (text/photo/video/document/etc) and it will be copied to all bot users (in DB) in batches.\n` +
    `Rate limit is capped at 28 messages/sec.`;

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('▶️ Start Broadcast', 'broadcast_start')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

const activeBroadcastByAdmin = new Set();

export async function handleBroadcastStart(ctx) {
  if (!(await requireAdmin(ctx))) return;
  setSession(ctx.from.id, { step: 'awaiting_broadcast_message', data: {} });
  await ctx.editMessageText(
    'Send the message to broadcast (any format).',
    Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'broadcast_menu')]])
  );
  await ctx.answerCbQuery();
}

async function runBroadcastCopy(telegram, adminId, fromChatId, messageId) {
  const batchSize = 500;
  let lastId = null;
  let enqueued = 0;
  let sent = 0;
  let failed = 0;

  while (true) {
    const q = { bannedAt: null };
    if (lastId) q._id = { $gt: lastId };
    const users = await BotUser.find(q).sort({ _id: 1 }).limit(batchSize).lean();
    if (!users.length) break;

    lastId = users[users.length - 1]._id;
    for (const u of users) {
      enqueued++;
      outboundQueue.enqueue(async () => {
        const ok = await safeCopyMessage(telegram, u.userId, fromChatId, messageId, null, 'broadcast');
        if (ok) sent++;
        else failed++;
      });
    }
    await waitForQueueBelow(3000);
  }

  await outboundQueue.onIdle();
  await safeSendMessage(
    telegram,
    adminId,
    `📣 Broadcast finished.\n\nEnqueued: ${enqueued}\nSent: ${sent}\nFailed: ${failed}`,
    null,
    'broadcast_done'
  );
}

export async function handleBroadcastMessage(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const adminId = ctx.from.id.toString();
  if (activeBroadcastByAdmin.has(adminId)) {
    clearSession(ctx.from.id);
    return ctx.reply('⚠️ A broadcast is already running.').catch(() => {});
  }

  const fromChatId = ctx.chat.id;
  const messageId = ctx.message?.message_id;
  clearSession(ctx.from.id);
  if (!messageId) return ctx.reply('⚠️ Invalid message. Try again.').catch(() => {});

  activeBroadcastByAdmin.add(adminId);
  await ctx.reply('✅ Broadcast started.').catch(() => {});

  runBroadcastCopy(ctx.telegram, adminId, fromChatId, messageId)
    .catch(err => console.error(`[broadcast] failed: ${err?.message || err}`))
    .finally(() => activeBroadcastByAdmin.delete(adminId));
}

function parseUserRefArg(raw) {
  const v = (raw || '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return { userId: v };
  const u = '@' + v.replace(/^@/, '');
  return { username: u };
}

export async function handleBanCommand(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (ctx.chat?.type !== 'private') return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const target = parseUserRefArg(parts[1]);
  const reason = parts.slice(2).join(' ').trim() || null;
  if (!target) return ctx.reply('Usage: /ban <userId|@username> [reason]').catch(() => {});

  const user = await BotUser.findOneAndUpdate(
    target,
    { $set: { bannedAt: new Date(), bannedBy: ctx.from.id.toString(), banReason: reason } },
    { new: true }
  );
  if (!user) return ctx.reply('User not found in DB.').catch(() => {});

  const requiredIds = (await getMandatoryChatIds()).filter(Boolean);
  let allRemoved = true;
  for (const cid of requiredIds) {
    const res = await removeUserFromChat(ctx.telegram, cid, user.userId, 'ban_command_remove');
    if (!res.ok) allRemoved = false;
  }
  if (allRemoved) await BotUser.updateOne({ _id: user._id }, { $set: { removedAt: new Date() } }).catch(() => {});
  if (!allRemoved) {
    await ctx.reply('⚠️ Banned, but I could not remove them from at least one mandatory chat. Make the bot an admin with ban permissions in all mandatory chats.').catch(() => {});
  }

  await ctx.reply(`🚫 Banned ${user.username || user.userId}${reason ? `\nReason: ${reason}` : ''}`).catch(() => {});
}

export async function handleUnbanCommand(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (ctx.chat?.type !== 'private') return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const target = parseUserRefArg(parts[1]);
  if (!target) return ctx.reply('Usage: /unban <userId|@username>').catch(() => {});

  const user = await BotUser.findOneAndUpdate(
    target,
    { $set: { bannedAt: null, bannedBy: null, banReason: null } },
    { new: true }
  );
  if (!user) return ctx.reply('User not found in DB.').catch(() => {});
  await ctx.reply(`✅ Unbanned ${user.username || user.userId}`).catch(() => {});
}

function fmtChatId(id) {
  if (!id) return 'not set';
  return id.toString();
}

function getSelectedInviterIds(s) {
  const ids = uniqStrings([...(s?.inviterAccountIds || []), s?.inviterAccountId].filter(Boolean));
  return ids;
}

export async function handleSettingsMenu(ctx) {
  const s = await getSettings();
  const [channels, groups] = await Promise.all([getMandatoryChannelIds(), getMandatoryGroupIds()]);
  const inviterIds = getSelectedInviterIds(s);
  const text =
    `⚙️ *Settings*\n\n` +
    `Mandatory channels (approved): ${channels.length}\n` +
    `Mandatory groups (approved): ${groups.length}\n` +
    `Inviter accounts selected: ${inviterIds.length}\n\n` +
    `Bot posting: ${s.botPostingEnabled ? '✅ ON' : '⛔ OFF'}\n` +
    `AI alerts: ${s.aiAlertsEnabled ? '✅ ON' : '⛔ OFF'}`;

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('Set Inviter Accounts', 'set_inviter_account')],
      [Markup.button.callback(s.botPostingEnabled ? 'Disable Posting' : 'Enable Posting', 'toggle_posting')],
      [Markup.button.callback(s.aiAlertsEnabled ? 'Disable AI Alerts' : 'Enable AI Alerts', 'toggle_ai_alerts')],
      [Markup.button.callback('Flush Queue', 'flush_queue')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

export async function handleSetInviterAccount(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const accounts = await Account.find({ session: { $nin: [null, ''] } }).sort({ createdAt: 1 });
  if (!accounts.length) {
    await ctx.answerCbQuery('No logged-in accounts');
    return handleSettingsMenu(ctx);
  }

  const preferred = accounts.filter(a => a.role === 'inviter');
  const list = preferred.length ? preferred : accounts;
  const s = await getSettings();
  const selected = new Set(getSelectedInviterIds(s));
  const buttons = list.slice(0, 12).map(a => {
    const id = a._id?.toString?.() || '';
    const mark = selected.has(id) ? '✅' : '⬜';
    return [
      Markup.button.callback(
        `${mark} ${a.username ? '@' + a.username : a.number} (${a.role})`,
        `pick_inviter_${a._id}`
      ),
    ];
  });
  buttons.push([Markup.button.callback('Clear Inviters', 'clear_inviter_account')]);
  buttons.push([Markup.button.callback('Done', 'settings_menu')]);

  await ctx.editMessageText('Select inviter accounts (must be admin in approved mandatory chats):', Markup.inlineKeyboard(buttons));
  await ctx.answerCbQuery();
}

export async function handlePickInviterAccount(ctx, accId) {
  if (!(await requireAdmin(ctx))) return;
  const acc = await Account.findById(accId);
  if (!acc?.session) {
    await ctx.answerCbQuery('Account not found');
    return handleSettingsMenu(ctx);
  }
  const s = await getSettings();
  const ids = getSelectedInviterIds(s);
  const id = acc._id.toString();
  if (ids.includes(id)) {
    s.inviterAccountIds = ids.filter(x => x !== id);
  } else {
    s.inviterAccountIds = [...ids, id];
  }
  s.inviterAccountId = null;
  await s.save();
  await ctx.answerCbQuery('✅ Saved');
  return handleSetInviterAccount(ctx);
}

export async function handleClearInviterAccount(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  s.inviterAccountId = null;
  s.inviterAccountIds = [];
  await s.save();
  await ctx.answerCbQuery('✅ Cleared');
  return handleSettingsMenu(ctx);
}

export async function handleTogglePosting(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  s.botPostingEnabled = !s.botPostingEnabled;
  await s.save();
  await ctx.answerCbQuery(s.botPostingEnabled ? '✅ Posting enabled' : '⛔ Posting disabled');
  if (s.botPostingEnabled) await flushQueuedPosts(ctx.telegram, s);
  return handleSettingsMenu(ctx);
}

export async function handleToggleAiAlerts(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  s.aiAlertsEnabled = !s.aiAlertsEnabled;
  await s.save();
  await ctx.answerCbQuery(s.aiAlertsEnabled ? '✅ AI alerts enabled' : '⛔ AI alerts disabled');
  return handleSettingsMenu(ctx);
}

function formatCandidatePost(fields) {
  const lines = [];
  if (fields.senderName) lines.push(fields.senderName);
  if (fields.senderId) lines.push(fields.senderId);
  if (fields.groupLink) lines.push(fields.groupLink);
  if (fields.messageLink) lines.push(fields.messageLink);
  if (fields.senderUsername) lines.push(fields.senderUsername);
  const suffix = lines.length ? `\n\n${lines.join('\n')}` : '';
  return `${fields.message}${suffix}`;
}

async function flushQueuedPosts(telegram, settings) {
  const targets = (await getMandatoryGroupIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  if (!targets.length) return;
  const posts = await QueuedPost.find({}).sort({ createdAt: 1 }).limit(200);
  for (const p of posts) {
    const text = formatCandidatePost(p);
    for (const target of targets) {
      await telegram.sendMessage(target, text, { disable_web_page_preview: true }).catch(() => {});
    }
    await QueuedPost.deleteOne({ _id: p._id });
  }
}

export async function handleFlushQueue(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  await flushQueuedPosts(ctx.telegram, s);
  await ctx.answerCbQuery('✅ Flushed');
  return handleSettingsMenu(ctx);
}

export async function handleGroupLinksMenu(ctx) {
  const [total, byStatus] = await Promise.all([
    GroupLink.countDocuments(),
    GroupLink.aggregate([{ $group: { _id: '$status', c: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(byStatus.map(r => [r._id, r.c]));
  const text =
    `🔗 *Group Links*\n\n` +
    `Total: *${total}*\n` +
    `New: *${counts.new || 0}*\n` +
    `Claimed: *${counts.claimed || 0}*\n` +
    `Joined: *${counts.joined || 0}*\n` +
    `Dead: *${counts.dead || 0}*`;

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('♻️ Reset Claimed → New', 'grouplinks_reset_claimed')],
      [Markup.button.callback('🧹 Delete Dead', 'grouplinks_delete_dead')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

export async function handleResetClaimed(ctx) {
  if (!(await requireAdmin(ctx))) return;
  await GroupLink.updateMany(
    { status: 'claimed' },
    { $set: { status: 'new', claimedByAccountId: null, claimedRole: null, claimedAt: null } }
  );
  await ctx.answerCbQuery('♻️ Reset done');
  return handleGroupLinksMenu(ctx);
}

export async function handleDeleteDead(ctx) {
  if (!(await requireAdmin(ctx))) return;
  await GroupLink.deleteMany({ status: 'dead' });
  await ctx.answerCbQuery('🧹 Deleted');
  return handleGroupLinksMenu(ctx);
}

export async function handleStartAll(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (!(await ensureOperationalPrereqs(ctx))) return;
  const accounts = await Account.find({ session: { $nin: [null, ''] } });
  for (const acc of accounts) {
    await startJoinWorker(acc._id);
    await startMessageWorker(acc._id);
  }
  await ctx.answerCbQuery(`▶️ Started workers for ${accounts.length} accounts`);
  return handleStart(ctx);
}

export async function handleStopAll(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const accounts = await Account.find({});
  for (const acc of accounts) {
    await stopJoinWorker(acc._id);
    await stopMessageWorker(acc._id);
  }
  await ctx.answerCbQuery('⏹️ All workers stopped');
  return handleStart(ctx);
}

export async function handleSubscribe(ctx) {
  const payload = JSON.stringify({ userId: ctx.from.id.toString(), kind: 'subscription' });
  await ctx.replyWithInvoice({
    title: 'Sujini Membership',
    description: '1 month access',
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: 'Monthly', amount: 100 }],
  });
  await ctx.answerCbQuery();
}

async function handleSuccessfulPayment(ctx) {
  try {
    const payment = ctx.message.successful_payment;
    const rawPayload = payment?.invoice_payload || '';
    let payload;
    try { payload = JSON.parse(rawPayload); } catch { payload = null; }
    if (!payload?.userId) return;

    const userId = payload.userId.toString();
    const username = ctx.from?.username ? '@' + ctx.from.username.replace(/^@/, '') : null;
    await BotUser.findOneAndUpdate(
      { userId },
      {
        $set: {
          pendingSubscriptionPaidAt: new Date(),
          pendingSubscriptionMonths: 1,
        },
        ...(username ? { $setOnInsert: { username } } : {}),
      },
      { upsert: true, new: true }
    );

    await Payment.create({
      userId,
      username,
      kind: 'subscription',
      currency: payment?.currency || 'XTR',
      totalAmount: Number(payment?.total_amount || 0),
      months: 1,
      invoicePayload: rawPayload || null,
      telegramPaymentChargeId: payment?.telegram_payment_charge_id || null,
      providerPaymentChargeId: payment?.provider_payment_charge_id || null,
    }).catch(() => {});

    const settings = await getSettings();
    const invites = await ensureUserInviteTickets(settings, userId);
    const channelIds = await getMandatoryChannelIds();
    const groupIds = await getMandatoryGroupIds();
    let msg = `✅ Payment received (${payment.total_amount} Stars).\n\nJoin the required chats to activate your subscription:`;
    for (const cid of channelIds) {
      const id = cid?.toString?.() || null;
      if (!id) continue;
      const link = invites.channels?.[id] || null;
      msg += `\n- channel (${id}): ${link || '(ask admin to set inviter accounts)'}`;
    }
    for (const gid of groupIds) {
      const id = gid?.toString?.() || null;
      if (!id) continue;
      const link = invites.groups?.[id] || null;
      msg += `\n- group (${id}): ${link || '(ask admin to set inviter accounts)'}`;
    }
    msg += `\n\nAfter joining, return to the bot and tap Refresh.`;
    await ctx.reply(msg, { disable_web_page_preview: true });
  } catch {
    await ctx.reply('✅ Payment received.');
  }
}

export async function handleMyChatMember(ctx) {
  try {
    const update = ctx.myChatMember;
    const newStatus = update.new_chat_member.status;
    const chat = ctx.chat;
    if (!chat?.title) return;

    if (newStatus === 'member' || newStatus === 'administrator') {
      await BotChat.findOneAndUpdate(
        { chatId: chat.id.toString() },
        { chatId: chat.id.toString(), title: chat.title, type: chat.type, username: chat.username || null },
        { upsert: true, new: true }
      );
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      await BotChat.deleteOne({ chatId: chat.id.toString() });
    }
  } catch {}
}

export async function handleChatMember(ctx) {
  try {
    const s = await getSettings();
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;
    const enforceIds = (await getMandatoryChatIds()).filter(Boolean).map(String);
    if (!enforceIds.includes(chatId)) return;

    const update = ctx.chatMember;
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;
    const user = update.new_chat_member.user;
    if (!user) return;

    const wasOut = oldStatus === 'left' || oldStatus === 'kicked';
    const isNowIn = newStatus === 'member' || newStatus === 'administrator' || newStatus === 'creator';
    if (!wasOut || !isNowIn) return;

    if (await isAdmin(user.id, user.username)) return;

    const u = await BotUser.findOne({ userId: user.id.toString() });
    if (!u) {
      const res = await removeUserFromChat(ctx.telegram, ctx.chat.id, user.id, 'join_without_record');
      if (!res.ok && shouldNotifyKickFail(`join_without_record:${chatId}:${user.id}`)) {
        await notifyAdmins(
          ctx.telegram,
          `⚠️ Sujini could not remove a user from a mandatory chat.\n\n` +
            `Chat: ${ctx.chat?.title || ''} (${chatId})\n` +
            `User: ${user.id} ${user.username ? '@' + user.username : ''}\n` +
            `Reason: ${res.desc || 'unknown_error'}\n\n` +
            `Fix: make the bot an admin with permission to ban users in that chat.`,
          'kick_fail_join_without_record'
        );
      }
      return;
    }

    if (u.bannedAt) {
      const res = await removeUserFromChat(ctx.telegram, ctx.chat.id, user.id, 'banned_join_attempt');
      if (!res.ok && shouldNotifyKickFail(`banned_join:${chatId}:${user.id}`)) {
        await notifyAdmins(
          ctx.telegram,
          `⚠️ Sujini could not remove a banned user from a mandatory chat.\n\n` +
            `Chat: ${ctx.chat?.title || ''} (${chatId})\n` +
            `User: ${user.id} ${user.username ? '@' + user.username : ''}\n` +
            `Reason: ${res.desc || 'unknown_error'}\n\n` +
            `Fix: make the bot an admin with permission to ban users in that chat.`,
          'kick_fail_banned_join'
        );
      }
      return;
    }

    await revokeUserInviteTicketsForChat(s, user.id.toString(), chatId).catch(() => {});
    await tryActivatePendingSubscription(s, ctx.telegram, user.id).catch(() => {});
    await finalizeOnboardingIfJoined(s, ctx.telegram, user.id.toString()).catch(() => {});

    const now = Date.now();
    const trialOk = u?.trialEndsAt && now < new Date(u.trialEndsAt).getTime();
    const subOk = u?.subscriptionEndsAt && now < new Date(u.subscriptionEndsAt).getTime();
    const pendingOk = (u?.pendingSubscriptionMonths || 0) > 0;
    const active = !!(trialOk || subOk || pendingOk);
    if (active) return;

    const res = await removeUserFromChat(ctx.telegram, ctx.chat.id, user.id, 'inactive_join_attempt');
    if (!res.ok && shouldNotifyKickFail(`inactive_join:${chatId}:${user.id}`)) {
      await notifyAdmins(
        ctx.telegram,
        `⚠️ Sujini could not remove an inactive user from a mandatory chat.\n\n` +
          `Chat: ${ctx.chat?.title || ''} (${chatId})\n` +
          `User: ${user.id} ${user.username ? '@' + user.username : ''}\n` +
          `Reason: ${res.desc || 'unknown_error'}\n\n` +
          `Fix: make the bot an admin with permission to ban users in that chat.`,
        'kick_fail_inactive_join'
      );
    }
    await safeSendMessage(ctx.telegram, user.id, 'You must start the bot and have an active subscription/trial to stay in the community.', null, 'inactive_join_attempt_dm');
  } catch {}
}

async function removeUserFromChat(telegram, chatId, userId, context = '') {
  const out = { ok: false, desc: null };
  try {
    await telegram.banChatMember(Number(chatId), Number(userId));
  } catch (err) {
    const { desc } = describeTelegramError(err);
    out.desc = desc;
    console.warn(`[kick] ${context} ban chatId=${chatId} userId=${userId} desc=${desc}`);
    return out;
  }

  try {
    await telegram.unbanChatMember(Number(chatId), Number(userId));
  } catch (err) {
    const { desc } = describeTelegramError(err);
    out.desc = desc;
    console.warn(`[kick] ${context} unban chatId=${chatId} userId=${userId} desc=${desc}`);
    return out;
  }

  out.ok = true;
  return out;
}

async function membershipSweep(telegram) {
  const s = await getSettings();
  const requiredIds = (await getMandatoryChatIds()).filter(Boolean);
  if (!requiredIds.length) return;

  const now = Date.now();
  const users = await BotUser.find({}).lean();

  for (const u of users) {
    if (u.bannedAt) {
      if (!u.removedAt) {
        let allRemoved = true;
        for (const cid of requiredIds) {
          const res = await removeUserFromChat(telegram, cid, u.userId, 'sweep_remove_banned');
          if (!res.ok) allRemoved = false;
        }
        if (allRemoved) {
          await BotUser.updateOne({ _id: u._id }, { $set: { removedAt: new Date() } });
        } else if (shouldNotifyKickFail(`sweep_banned:${u.userId}`)) {
          await notifyAdmins(
            telegram,
            `⚠️ Sujini could not remove a banned user from at least one mandatory chat.\n\nUser: ${u.userId}${u.username ? ' @' + u.username : ''}\nFix: make the bot an admin with permission to ban users in all mandatory chats.`,
            'kick_fail_sweep_banned'
          );
        }
      }
      continue;
    }

    if ((u.pendingSubscriptionMonths || 0) > 0) {
      await tryActivatePendingSubscription(s, telegram, u.userId).catch(() => {});
    }

    if (!u.mandatoryJoinedAt && u.joinPromptMessageId) {
      await finalizeOnboardingIfJoined(s, telegram, u.userId).catch(() => {});
    }

    const trialEnds = u.trialEndsAt ? new Date(u.trialEndsAt).getTime() : 0;
    const subEnds = u.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).getTime() : 0;
    const pending = (u.pendingSubscriptionMonths || 0) > 0;
    const active = pending || (trialEnds && now < trialEnds) || (subEnds && now < subEnds);

    if (trialEnds && now < trialEnds) {
      const msLeft = trialEnds - now;
      if (msLeft <= BILLING.trialReminder8hMsBeforeEnd && msLeft > BILLING.trialReminder2hMsBeforeEnd && !u.trialReminder8hSentAt) {
        await BotUser.updateOne({ _id: u._id }, { $set: { trialReminder8hSentAt: new Date() } });
        const msg = BILLING.testMode
          ? 'Trial expires soon (test mode). Pay 100 Stars to continue.'
          : 'Trial expires in ~8 hours. Pay 100 Stars to continue.';
        outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'trial_reminder_1'));
      }
      if (msLeft <= BILLING.trialReminder2hMsBeforeEnd && msLeft > 0 && !u.trialReminder2hSentAt) {
        await BotUser.updateOne({ _id: u._id }, { $set: { trialReminder2hSentAt: new Date() } });
        const msg = BILLING.testMode
          ? 'Trial expires very soon (test mode). Pay 100 Stars to continue.'
          : 'Trial expires in ~2 hours. Pay 100 Stars to continue.';
        outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'trial_reminder_2'));
      }
    }

    if (subEnds && now < subEnds) {
      const msLeft = subEnds - now;
      if (msLeft <= BILLING.subReminder3dMsBeforeEnd && msLeft > 0 && !u.expiryReminder3dSentAt) {
        await BotUser.updateOne({ _id: u._id }, { $set: { expiryReminder3dSentAt: new Date() } });
        const msg = BILLING.testMode
          ? 'Subscription expires soon (test mode). Pay 100 Stars to renew.'
          : 'Subscription expires in ~3 days. Pay 100 Stars to renew.';
        outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'sub_reminder'));
      }
    }

    if (!active && !pending && !u.removedAt && (trialEnds || subEnds)) {
      let allRemoved = true;
      for (const cid of requiredIds) {
        const res = await removeUserFromChat(telegram, cid, u.userId, 'sweep_remove_expired');
        if (!res.ok) allRemoved = false;
      }
      if (allRemoved) {
        await BotUser.updateOne({ _id: u._id }, { $set: { removedAt: new Date() } });
        outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, 'Your access expired and you were removed. Pay 100 Stars to rejoin.', pay100Keyboard(), 'expired_removed'));
      } else if (shouldNotifyKickFail(`sweep_expired:${u.userId}`)) {
        await notifyAdmins(
          telegram,
          `⚠️ Sujini could not remove an expired user from at least one mandatory chat.\n\nUser: ${u.userId}${u.username ? ' @' + u.username : ''}\nFix: make the bot an admin with permission to ban users in all mandatory chats.`,
          'kick_fail_sweep_expired'
        );
      }
    }
  }
}

export async function handleMessage(ctx) {
  if (ctx.message?.successful_payment) return handleSuccessfulPayment(ctx);

  const session = getSession(ctx.from?.id);
  if (!session) return;
  if (session.step === 'awaiting_broadcast_message') return handleBroadcastMessage(ctx);
  if (!ctx.message?.text) return;

  switch (session.step) {
    case 'awaiting_account_role':          return;
    case 'awaiting_number':               return handlePhoneNumber(ctx, session);
    case 'awaiting_code':                 return handleVerificationCode(ctx, session);
    case 'awaiting_password':             return handlePassword(ctx, session);
    case 'awaiting_keywords':             return handleKeywordsInput(ctx);
    case 'awaiting_admin_id':             return handleAdminIdInput(ctx);
    case 'awaiting_template_text':        return handleTemplateTextInput(ctx);
  }
}

export function setupHandlers(bot) {
  ensureAdminCacheLoaded().catch(() => {});
  ensureApprovedChatCacheLoaded().catch(() => {});

  bot.catch((err, ctx) => {
    ctx?.answerCbQuery?.('❌ Something went wrong').catch(() => {});
    console.error(`[Bot Error] ${err.message}`);
  });

  bot.use((ctx, next) => authorizedGroupMiddleware(ctx, next));

  bot.command('start', handleStart);
  bot.command('ban', handleBanCommand);
  bot.command('unban', handleUnbanCommand);
  bot.on('message', handleMessage);
  bot.on('pre_checkout_query', async (ctx) => { try { await ctx.answerPreCheckoutQuery(true); } catch {} });

  bot.action('back_to_main', handleStart);
  bot.action('user_refresh', (ctx) => handleUserStart(ctx));
  bot.action('subscribe_100', handleSubscribe);

  bot.action('accounts', handleAccounts);
  bot.action('add_account', handleAddAccount);
  bot.action('pick_role_listener', (ctx) => handlePickAccountRole(ctx, 'listener'));
  bot.action('pick_role_preacher', (ctx) => handlePickAccountRole(ctx, 'preacher'));
  bot.action('pick_role_finder', (ctx) => handlePickAccountRole(ctx, 'finder'));
  bot.action('pick_role_inviter', (ctx) => handlePickAccountRole(ctx, 'inviter'));
  bot.action(/^acc_(.+)$/, ctx => handleAccountDetail(ctx, ctx.match[1]));
  bot.action(/^logout_(.+)$/, ctx => handleLogout(ctx, ctx.match[1]));
  bot.action(/^start_join_(.+)$/, async ctx => {
    if (!(await ensureOperationalPrereqs(ctx))) return;
    await startJoinWorker(ctx.match[1]);
    await ctx.answerCbQuery('▶️ Started');
    return handleAccountDetail(ctx, ctx.match[1]);
  });
  bot.action(/^stop_join_(.+)$/, async ctx => {
    await stopJoinWorker(ctx.match[1]);
    await ctx.answerCbQuery('⏹️ Stopped');
    return handleAccountDetail(ctx, ctx.match[1]);
  });
  bot.action(/^start_msg_(.+)$/, async ctx => {
    if (!(await ensureOperationalPrereqs(ctx))) return;
    await startMessageWorker(ctx.match[1]);
    await ctx.answerCbQuery('▶️ Started');
    return handleAccountDetail(ctx, ctx.match[1]);
  });
  bot.action(/^stop_msg_(.+)$/, async ctx => {
    await stopMessageWorker(ctx.match[1]);
    await ctx.answerCbQuery('⏹️ Stopped');
    return handleAccountDetail(ctx, ctx.match[1]);
  });

  bot.action('admins_menu', handleAdminsMenu);
  bot.action('add_admin', handleAddAdmin);
  bot.action('remove_admin_list', handleRemoveAdminList);
  bot.action(/^del_admin_(.+)$/, ctx => handleDeleteAdmin(ctx, ctx.match[1]));

  bot.action('templates_menu', handleTemplatesMenu);
  bot.action('template_add', handleAddTemplate);
  bot.action('template_view', handleViewTemplates);
  bot.action(/^del_tpl_(.+)$/, (ctx) => handleDeleteTemplate(ctx, ctx.match[1]));

  bot.action('keywords_menu', handleKeywordsMenu);
  bot.action('add_keywords', handleAddKeywords);
  bot.action(/^view_keywords_(\d+)$/, ctx => handleViewKeywords(ctx, parseInt(ctx.match[1])));
  bot.action(/^del_kw_(.+)$/, ctx => handleDeleteKeyword(ctx, ctx.match[1]));

  bot.action('grouplinks_menu', handleGroupLinksMenu);
  bot.action('grouplinks_reset_claimed', handleResetClaimed);
  bot.action('grouplinks_delete_dead', handleDeleteDead);

  bot.action('auth_groups', (ctx) => handleAuthGroupsMenu(ctx, 0));
  bot.action(/^auth_groups_page_(\d+)$/, ctx => handleAuthGroupsMenu(ctx, parseInt(ctx.match[1])));
  bot.action(/^toggle_auth_(-?\d+)$/, ctx => handleToggleAuthChat(ctx, ctx.match[1]));

  bot.action('auth_channels', (ctx) => handleAuthChannelsMenu(ctx, 0));
  bot.action(/^auth_channels_page_(\d+)$/, ctx => handleAuthChannelsMenu(ctx, parseInt(ctx.match[1])));
  bot.action(/^toggle_auth_ch_(-?\d+)$/, ctx => handleToggleAuthChannel(ctx, ctx.match[1]));

  bot.action('broadcast_menu', handleBroadcastMenu);
  bot.action('broadcast_start', handleBroadcastStart);

  bot.action('settings_menu', handleSettingsMenu);
  bot.action('toggle_posting', handleTogglePosting);
  bot.action('toggle_ai_alerts', handleToggleAiAlerts);
  bot.action('flush_queue', handleFlushQueue);
  bot.action('set_inviter_account', handleSetInviterAccount);
  bot.action(/^pick_inviter_(.+)$/, ctx => handlePickInviterAccount(ctx, ctx.match[1]));
  bot.action('clear_inviter_account', handleClearInviterAccount);

  bot.on('chat_member', handleChatMember);
  bot.on('my_chat_member', handleMyChatMember);

  bot.action('start_all', handleStartAll);
  bot.action('stop_all', handleStopAll);

  startPoller();
}

export async function seedOnStartup() {
  const kwCount = await Keyword.countDocuments();
  if (!kwCount) {
    try {
      await Keyword.insertMany(SEED_KEYWORDS.map(w => ({ word: w.toLowerCase() })), { ordered: false });
    } catch {}
  }

  const adminCount = await Admin.countDocuments();
  if (!adminCount && process.env.BOT_ADMIN_ID) {
    await Admin.create({ userId: process.env.BOT_ADMIN_ID });
  }
}

export function startSchedulers(telegram) {
  membershipSweep(telegram).catch(() => {});
  setInterval(() => membershipSweep(telegram).catch(() => {}), 15 * 1000);
}
