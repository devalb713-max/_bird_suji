import { Markup } from 'telegraf';
import { randomBytes } from 'node:crypto';
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
  Referral,
  Payment,
  InviteTicket,
  MessageTemplate,
  QueuedPost,
  GroupLink,
  AiQueueMessage,
  PostDedupe,
} from '../models/db.js';
import { sendCodeWithRetry } from '../helpers/telegram.js';
import { randomFingerprint } from '../helpers/fingerprint.js';
import { startJoinWorker, stopJoinWorker, isJoinWorkerRunning, isAnyJoinWorkerRunning, startPoller } from '../workers/joinWorker.js';
import { startMessageWorker, stopMessageWorker, isMessageWorkerRunning, isAnyMessageWorkerRunning } from '../workers/messageWorker.js';
import { SEED_KEYWORDS } from '../models/keywords.js';
import { buildCandidatePost, contentHash } from '../helpers/messenger.js';

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
  const subReminder1dMsBeforeEnd = testMode ? 4 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return { testMode, trialMs, monthMs, trialReminder8hMsBeforeEnd, trialReminder2hMsBeforeEnd, subReminder3dMsBeforeEnd, subReminder1dMsBeforeEnd };
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

function isStaleCallbackQueryError(err) {
  const { code, desc } = describeTelegramError(err);
  if (Number(code) !== 400) return false;
  const d = (desc || '').toString().toLowerCase();
  return d.includes('query is too old') || d.includes('response timeout expired') || d.includes('query id is invalid');
}

function isMessageNotModifiedError(err) {
  const { code, desc } = describeTelegramError(err);
  if (Number(code) !== 400) return false;
  const d = (desc || '').toString().toLowerCase();
  return d.includes('message is not modified');
}

function isCantParseEntitiesError(err) {
  const { code, desc } = describeTelegramError(err);
  if (Number(code) !== 400) return false;
  const d = (desc || '').toString().toLowerCase();
  return d.includes("can't parse entities");
}

function isServiceSpamMessage(msg) {
  if (!msg) return false;
  return !!(
    (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) ||
    msg.left_chat_member ||
    msg.new_chat_title ||
    msg.new_chat_photo ||
    msg.delete_chat_photo ||
    msg.group_chat_created ||
    msg.supergroup_chat_created ||
    msg.channel_chat_created ||
    msg.message_auto_delete_timer_changed ||
    msg.pinned_message ||
    msg.migrate_to_chat_id ||
    msg.migrate_from_chat_id ||
    msg.video_chat_started ||
    msg.video_chat_ended ||
    msg.video_chat_participants_invited ||
    msg.forum_topic_created ||
    msg.forum_topic_edited ||
    msg.forum_topic_closed ||
    msg.forum_topic_reopened ||
    msg.general_forum_topic_hidden ||
    msg.general_forum_topic_unhidden
  );
}

const recentGateRuns = new Map();

async function computeUserAccessState(settings, telegram, userIdStr) {
  const userId = userIdStr?.toString?.() || '';
  if (!userId) return { exists: false, active: false, banned: false, user: null };

  const existing = await BotUser.findOne({ userId }).lean();
  if (!existing) return { exists: false, active: false, banned: false, user: null };
  if (existing.bannedAt) return { exists: true, active: false, banned: true, user: existing };

  if ((existing.pendingSubscriptionMonths || 0) > 0) {
    await tryActivatePendingSubscription(settings, telegram, userId).catch(() => {});
  }

  if (!existing.mandatoryJoinedAt && existing.joinPromptMessageId) {
    await finalizeOnboardingIfJoined(settings, telegram, userId).catch(() => {});
  }

  const user = await BotUser.findOne({ userId }).lean();
  if (!user) return { exists: false, active: false, banned: false, user: null };
  if (user.bannedAt) return { exists: true, active: false, banned: true, user };

  const now = Date.now();
  const trialOk = user?.trialEndsAt && now < new Date(user.trialEndsAt).getTime();
  const subOk = user?.subscriptionEndsAt && now < new Date(user.subscriptionEndsAt).getTime();
  const pendingOk = (user?.pendingSubscriptionMonths || 0) > 0;
  const active = !!(trialOk || subOk || pendingOk);

  return { exists: true, active, banned: false, user };
}

async function enforceMandatoryJoinGate(settings, telegram, chatId, joinedUser, context = '') {
  const chatIdStr = chatId?.toString?.() || null;
  if (!chatIdStr) return false;

  const nowMs = Date.now();
  const debounceKey = `${chatIdStr}:${joinedUser?.id || ''}`;
  if (debounceKey) {
    const last = recentGateRuns.get(debounceKey) || 0;
    if (nowMs - last < 12_000) return false;
    recentGateRuns.set(debounceKey, nowMs);
    if (recentGateRuns.size > 5000) {
      for (const [k, t] of recentGateRuns) {
        if (nowMs - t > 60_000) recentGateRuns.delete(k);
      }
    }
  }

  const enforceIds = (await getMandatoryChatIds()).filter(Boolean).map(String);
  if (!enforceIds.includes(chatIdStr)) return false;

  const userId = joinedUser?.id;
  if (!userId) return false;
  if (await isAdmin(userId, joinedUser?.username)) return false;

  const state = await computeUserAccessState(settings, telegram, userId.toString());
  if (!state.exists) {
    await removeUserFromChat(telegram, chatIdStr, userId, `${context || 'gate'}_no_record`);
    return true;
  }
  if (state.banned) {
    await removeUserFromChat(telegram, chatIdStr, userId, `${context || 'gate'}_banned`);
    return true;
  }
  if (state.active) return false;

  const graceUntil = state?.user?.onboardingGraceUntil ? new Date(state.user.onboardingGraceUntil).getTime() : 0;
  if (graceUntil && Date.now() < graceUntil) return false;

  await removeUserFromChat(telegram, chatIdStr, userId, `${context || 'gate'}_inactive`);
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
      inline_keyboard: [
        [
          { text: '🪙 Pay 100 Sujicards', callback_data: 'subscribe_cards' },
          { text: '💳 Pay 100 Stars', callback_data: 'subscribe_100' },
        ],
      ],
    },
  };
}

function sujicardConfirmKeyboard(nonce, cost) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `✅ Confirm ${cost} Sujicards`, callback_data: `subscribe_cards_confirm_${nonce}` }],
        [{ text: '❌ Cancel', callback_data: `subscribe_cards_cancel_${nonce}` }],
      ],
    },
  };
}

function newNonce() {
  return randomBytes(6).toString('hex');
}

const SUJICARDS = {
  perReferral: 1,
  monthlySubCost: 100,
};

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
const authClients = new Map();

function getSession(userId) { return userSessions.get(userId.toString()); }
function setSession(userId, data) { userSessions.set(userId.toString(), data); }
function clearSession(userId) { userSessions.delete(userId.toString()); }

function getAuthClient(adminId) { return authClients.get(adminId.toString()) || null; }
function setAuthClient(adminId, client) { authClients.set(adminId.toString(), client); }
function clearAuthClient(adminId) { authClients.delete(adminId.toString()); }

async function withTimeout(promise, ms, label = 'timeout') {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
    if (t?.unref) t.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

const MEMBERSHIP_SWEEP_LEASE_ID = `membership_sweep:${process.pid}:${randomBytes(6).toString('hex')}`;
const MEMBERSHIP_SWEEP_LEASE_MS = 2 * 60 * 1000;

async function getSettings() {
  const existing = await BotSettings.findOne({});
  if (existing) return existing;
  return BotSettings.create({});
}

let _listenerGroupsAnnounceRunning = false;

function formatCompactCount(n) {
  const value = Number(n || 0);
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100000) return Math.trunc(value).toLocaleString('en-US');
  if (value < 1000) return Math.trunc(value).toString();
  const k = value / 1000;
  const fixed = k < 10 ? k.toFixed(1) : k.toFixed(1);
  const trimmed = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  return `${trimmed}k`;
}

function normalizeLinkKey(link) {
  try {
    const u = new URL(link);
    return `https://t.me/${u.pathname.replace(/^\//, '').toLowerCase()}`;
  } catch {
    return (link || '').toString().toLowerCase().trim();
  }
}

async function getAnnouncementTargetChatIds() {
  const s = await getSettings();
  const targets = [];
  const channelId = s?.requiredChannelId ? Number(s.requiredChannelId) : null;
  const groupId = s?.requiredGroupId ? Number(s.requiredGroupId) : null;
  if (channelId && Number.isFinite(channelId)) targets.push(channelId);
  if (groupId && Number.isFinite(groupId)) targets.push(groupId);
  if (targets.length) return [...new Set(targets)];

  const configured = s?.jobsTargetChatId ? Number(s.jobsTargetChatId) : null;
  if (configured && Number.isFinite(configured)) return [configured];

  return [];
}

async function announceListenerGroupsProgress(telegram) {
  if (_listenerGroupsAnnounceRunning) return;
  _listenerGroupsAnnounceRunning = true;
  try {
    const settings = await getSettings();
    if (!settings?.botPostingEnabled) return;

    const agg = await Account.aggregate([
      { $match: { role: { $ne: 'inviter' } } },
      { $project: { groups: 1 } },
      { $unwind: '$groups' },
      {
        $project: {
          idRaw: { $ifNull: ['$groups.id', ''] },
          linkRaw: { $ifNull: ['$groups.normalizedLink', '$groups.link'] },
        },
      },
      {
        $project: {
          idStr: {
            $cond: [
              { $and: [{ $ne: ['$idRaw', null] }, { $ne: ['$idRaw', ''] }] },
              { $toString: '$idRaw' },
              '',
            ],
          },
          linkStr: {
            $cond: [
              { $and: [{ $ne: ['$linkRaw', null] }, { $ne: ['$linkRaw', ''] }] },
              { $toString: '$linkRaw' },
              '',
            ],
          },
        },
      },
      {
        $project: {
          key: {
            $cond: [
              { $ne: ['$idStr', ''] },
              { $concat: ['id:', '$idStr'] },
              {
                $cond: [
                  { $ne: ['$linkStr', ''] },
                  { $concat: ['link:', { $toLower: '$linkStr' }] },
                  null,
                ],
              },
            ],
          },
        },
      },
      { $match: { key: { $ne: null } } },
      { $group: { _id: '$key' } },
      { $count: 'count' },
    ]).allowDiskUse(true);
    const count = Number(agg?.[0]?.count || 0);
    const lastCount = Number(settings.listenerGroupsAnnouncedCount || 0);
    if (!(count >= lastCount + 40)) return;

    const targets = await getAnnouncementTargetChatIds();
    if (!targets.length) return;

    const pretty = formatCompactCount(count);
    const msg =
      `🔥🦅 Sujini has joined ${pretty} groups so far.\n\n` +
      `I’ll keep fetching gigs for y’all.`;

    const results = await Promise.allSettled(
      targets.map((chatId) => telegram.sendMessage(chatId, msg, { disable_web_page_preview: true }))
    );
    const sentAny = results.some((r) => r.status === 'fulfilled');
    if (sentAny) {
      await BotSettings.updateOne(
        { _id: settings._id },
        { $set: { listenerGroupsAnnouncedCount: count, listenerGroupsAnnouncedAt: new Date() } }
      ).catch(() => {});
    }
  } finally {
    _listenerGroupsAnnounceRunning = false;
  }
}

function mainMenu() {
  const anyRunning = isAnyJoinWorkerRunning() || isAnyMessageWorkerRunning();
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
    [Markup.button.callback(anyRunning ? '🔴 Stop All' : '🟢 Start All', 'toggle_all')],
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

async function approveChat(chatId, type = 'group', approvedBy = null, inviteLink = null) {
  const patch = {
    chatId: chatId.toString(),
    type,
    approvedBy: approvedBy ? approvedBy.toString() : null,
    approvedAt: new Date(),
  };
  const link = inviteLink ? inviteLink.toString().trim() : '';
  if (link) {
    patch.inviteLink = link;
    patch.inviteLinkUpdatedAt = new Date();
    patch.inviteLinkByAccountId = null;
  }
  await ApprovedChat.findOneAndUpdate(
    { chatId: chatId.toString() },
    { $set: patch },
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
    const uname = chat?.username ? chat.username.toString().replace(/^@/, '').trim() : '';
    const link = uname ? `https://t.me/${uname}` : null;
    await approveChat(chatId, 'group', from.id, link).catch(() => {});
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
    await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...mainMenu() });
    await ctx.answerCbQuery();
  } else {
    await safeReply(ctx, text, { parse_mode: 'Markdown', ...mainMenu() });
  }
}

function getStartPayload(ctx) {
  const sp = ctx?.startPayload;
  if (sp != null && sp !== '') return sp.toString().trim() || null;
  const text = (ctx?.message?.text || '').toString();
  const m = text.match(/^\/start(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  return (m?.[1] || '').toString().trim() || null;
}

function parseReferralOwnerUserId(payload) {
  const m = payload ? payload.toString().trim().match(/^ref_(\d+)$/i) : null;
  return m?.[1] ? m[1].toString() : null;
}

let _botPublicUsername = null;
async function getBotPublicUsername(telegram) {
  if (_botPublicUsername) return _botPublicUsername;
  const me = await telegram.getMe().catch(() => null);
  const u = me?.username ? me.username.toString() : null;
  _botPublicUsername = u;
  return u;
}

async function getReferralCount(userId) {
  const id = userId.toString();
  return Referral.countDocuments({ referrerUserId: id, status: { $in: ['pending', 'credited'] } });
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 || (err?.message || '').toString().includes('E11000 duplicate key error');
}

async function ensureBotUser(ctx) {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? '@' + ctx.from.username.replace(/^@/, '') : null;
  let isNew = false;
  let user = await BotUser.findOne({ userId });
  if (!user) {
    isNew = true;
    const startPayload = getStartPayload(ctx);
    const ownerId = parseReferralOwnerUserId(startPayload);
    let referredByUserId = null;
    let referredAt = null;
    let ownerDoc = null;

    if (ownerId && ownerId !== userId) {
      ownerDoc = await BotUser.findOne({ userId: ownerId }).lean();
      if (ownerDoc) {
        referredByUserId = ownerId;
        referredAt = new Date();
      }
    }

    try {
      user = await BotUser.create({
        userId,
        username,
        trialStartedAt: new Date(),
        trialEndsAt: new Date(Date.now() + BILLING.trialMs),
        referredByUserId,
        referredAt,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      isNew = false;
      user = await BotUser.findOne({ userId });
      if (username && user?.username !== username) {
        await BotUser.updateOne({ userId }, { $set: { username } }).catch(() => {});
      }
      return { user, isNew };
    }

    if (referredByUserId && ownerDoc) {
      await Referral.create({
        referrerUserId: referredByUserId,
        referrerUsername: ownerDoc.username || null,
        referredUserId: userId,
        referredUsername: username || null,
        status: 'pending',
        clickedAt: new Date(),
      }).catch(() => {});

      const who = username || userId;
      await safeSendMessage(
        ctx.telegram,
        referredByUserId,
        `🔥🦅 Referral: ${who} (+${SUJICARDS.perReferral} when they join)`,
        null,
        'referral_click_notify'
      );
    }
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

function extractInviteHashFromLink(link = '') {
  if (!link) return null;
  try {
    const u = new URL(link);
    const path = u.pathname.replace(/^\//, '');
    if (path.startsWith('+')) return path.slice(1).split('/')[0] || null;
    if (path.toLowerCase().startsWith('joinchat/')) return path.slice('joinchat/'.length).split('/')[0] || null;
    return null;
  } catch {
    const s = (link || '').toString().trim();
    const m1 = s.match(/t\.me\/\+([A-Za-z0-9_-]+)/i);
    if (m1?.[1]) return m1[1];
    const m2 = s.match(/t\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
    if (m2?.[1]) return m2[1];
    return null;
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
  if (candidates.length) {
    try {
      const dialogs = await client.getDialogs({ limit: 200 });
      const cand = new Set(candidates.map((c) => c?.toString?.()).filter(Boolean));
      for (const d of dialogs || []) {
        const ent = d?.entity || null;
        const entId = ent?.id?.toString?.() || null;
        if (entId && cand.has(entId)) return ent;
      }
    } catch {}
  }
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
    await client.getDialogs({ limit: 200 }).catch(() => {});
    return await fn(client);
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function createSingleUseInviteLink(inviterAcc, chatIdStr, inviteLink, title) {
  return withInviterClient(inviterAcc, async (client) => {
    const peer = await resolveInviterPeer(client, chatIdStr, inviteLink);
    const suffix = Math.random().toString(16).slice(2, 10);
    const rawTitle = `${(title || 'sujini').toString()}:${suffix}`;
    const safeTitle = rawTitle.slice(0, 32);

    const res = await client.invoke(new Api.messages.ExportChatInvite({
      peer,
      requestNeeded: false,
      title: safeTitle,
    }));
    const link = res?.link || null;
    if (!link) return null;
    const hash = extractInviteHashFromLink(link);
    if (hash) {
      await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    }
    return link;
  });
}

async function revokeInviteLink(inviterAcc, chatIdStr, inviteLink, linkToRevoke) {
  return withInviterClient(inviterAcc, async (client) => {
    const peer = await resolveInviterPeer(client, chatIdStr, inviteLink);
    await client.invoke(new Api.messages.DeleteExportedChatInvite({ peer, link: linkToRevoke }));
    return true;
  });
}

async function getChatLinkHintsByIds(chatIds) {
  const ids = (chatIds || []).map((c) => c?.toString?.()).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await BotChat.find({ chatId: { $in: ids } }, { chatId: 1, username: 1 }).lean().catch(() => []);
  const map = new Map();
  for (const r of rows || []) {
    const cid = r?.chatId?.toString?.() || null;
    if (!cid) continue;
    const u = normalizeUsername(r?.username || '');
    map.set(cid, u ? `https://t.me/${u}` : null);
  }
  return map;
}

async function ensureApprovedChatInviteLink(settings, chatIdStr) {
  const chatId = chatIdStr?.toString?.() || null;
  if (!chatId) return null;

  const requiredChannelId = settings?.requiredChannelId?.toString?.() || null;
  const requiredGroupId = settings?.requiredGroupId?.toString?.() || null;
  if (requiredChannelId && chatId === requiredChannelId && settings?.requiredChannelInviteLink) {
    return settings.requiredChannelInviteLink;
  }
  if (requiredGroupId && chatId === requiredGroupId && settings?.requiredGroupInviteLink) {
    return settings.requiredGroupInviteLink;
  }

  const approved = await ApprovedChat.findOne({ chatId }).lean().catch(() => null);

  if (approved?.inviteLink) return approved.inviteLink;

  const botChat = await BotChat.findOne({ chatId }, { username: 1 }).lean().catch(() => null);
  const uname = normalizeUsername(botChat?.username || '');
  if (uname) {
    const link = `https://t.me/${uname}`;
    if (approved?._id) {
      await ApprovedChat.updateOne(
        { chatId },
        { $set: { inviteLink: link, inviteLinkUpdatedAt: new Date(), inviteLinkByAccountId: null } }
      ).catch(() => {});
    } else if (requiredChannelId && chatId === requiredChannelId) {
      await BotSettings.updateOne({ _id: settings._id }, { $set: { requiredChannelInviteLink: link } }).catch(() => {});
    } else if (requiredGroupId && chatId === requiredGroupId) {
      await BotSettings.updateOne({ _id: settings._id }, { $set: { requiredGroupInviteLink: link } }).catch(() => {});
    }
    return link;
  }

  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return null;

  for (let i = 0; i < inviters.length; i += 1) {
    const inviter = pickInviterAccount(inviters);
    try {
      const inferredType =
        approved?.type ||
        (requiredChannelId && chatId === requiredChannelId ? 'channel' : null) ||
        (requiredGroupId && chatId === requiredGroupId ? 'group' : null) ||
        'chat';
      const link = await createSingleUseInviteLink(inviter, chatId, '', `sujini:${inferredType}:${chatId}`);
      if (!link) continue;
      if (approved?._id) {
        await ApprovedChat.updateOne(
          { chatId },
          { $set: { inviteLink: link, inviteLinkUpdatedAt: new Date(), inviteLinkByAccountId: inviter?._id?.toString?.() || null } }
        ).catch(() => {});
      } else if (requiredChannelId && chatId === requiredChannelId) {
        await BotSettings.updateOne({ _id: settings._id }, { $set: { requiredChannelInviteLink: link } }).catch(() => {});
      } else if (requiredGroupId && chatId === requiredGroupId) {
        await BotSettings.updateOne({ _id: settings._id }, { $set: { requiredGroupInviteLink: link } }).catch(() => {});
      }
      return link;
    } catch {}
  }
  return null;
}

async function ensureUserInviteTickets(settings, userId, opts = null) {
  const only = Array.isArray(opts?.chatIds) && opts.chatIds.length
    ? new Set(opts.chatIds.map((x) => x?.toString?.()).filter(Boolean))
    : null;

  const out = { channels: {}, groups: {} };
  const allChannelIds = await getMandatoryChannelIds();
  const allGroupIds = await getMandatoryGroupIds();
  const channelIds = only ? allChannelIds.filter((id) => only.has(id?.toString?.() || '')) : allChannelIds;
  const groupIds = only ? allGroupIds.filter((id) => only.has(id?.toString?.() || '')) : allGroupIds;

  for (const channelId of channelIds) {
    const cid = channelId?.toString?.() || null;
    if (!cid) continue;
    const link = await ensureApprovedChatInviteLink(settings, cid).catch(() => null);
    if (link) out.channels[cid] = link;
  }
  for (const groupId of groupIds) {
    const gid = groupId?.toString?.() || null;
    if (!gid) continue;
    const link = await ensureApprovedChatInviteLink(settings, gid).catch(() => null);
    if (link) out.groups[gid] = link;
  }

  return out;
}

async function revokeUserInviteTicketsForChat(settings, userId, chatIdStr) {
  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return;
  const hints = await getChatLinkHintsByIds([chatIdStr]);
  const hint = hints.get(chatIdStr.toString()) || '';

  const tickets = await InviteTicket.find({ userId, chatId: chatIdStr.toString(), revokedAt: null }).lean();
  if (!tickets.length) return;

  for (const t of tickets) {
    const preferred = t?.inviterAccountId ? inviters.find(a => a._id?.toString?.() === t.inviterAccountId) : null;
    const order = preferred ? [preferred, ...inviters.filter(a => a !== preferred)] : inviters;
    for (const inviter of order) {
      try {
        await revokeInviteLink(inviter, chatIdStr.toString(), hint, t.link);
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

  const until = newEnd;
  await safeSendMessage(telegram, userId, '🔥 🦅 Wings deployed. Subscription confirmed.', null, 'activate_sub_1');
  await safeSendMessage(
    telegram,
    userId,
    `I’ll keep hunting developer job requests for you from now until ${formatHumanDate(until)}.\n\nKeep checking the community group — drops can land anytime.`,
    null,
    'activate_sub_2'
  );
  return true;
}

function getFriendlyName(from) {
  const first = (from?.first_name || '').toString().trim();
  if (first) return first;
  const uname = (from?.username || '').toString().replace(/^@/, '').trim();
  if (uname) return '@' + uname;
  return 'friend';
}

function formatHumanDate(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return 'soon';
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatHumanTimeLeft(msLeft) {
  const ms = Math.max(0, Number(msLeft) || 0);
  const minutes = Math.round(ms / 60000);
  if (minutes <= 1) return 'about a minute';
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return 'about 1 hour';
  if (hours < 48) return `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'about 1 day' : `about ${days} days`;
}

function formatTrialTimeLeft(msLeft) {
  const ms = Math.max(0, Number(msLeft) || 0);
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours === 1) return '1 hour';
  if (hours < 24) return `${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

async function acquireMembershipSweepLease(settings) {
  const now = new Date();
  const expiresAt = new Date(Date.now() + MEMBERSHIP_SWEEP_LEASE_MS);
  const res = await BotSettings.updateOne(
    {
      _id: settings._id,
      $or: [
        { membershipSweepLeaseExpiresAt: null },
        { membershipSweepLeaseExpiresAt: { $lt: now } },
        { membershipSweepLeaseId: MEMBERSHIP_SWEEP_LEASE_ID },
      ],
    },
    { $set: { membershipSweepLeaseId: MEMBERSHIP_SWEEP_LEASE_ID, membershipSweepLeaseExpiresAt: expiresAt, membershipSweepLeaseUpdatedAt: now } }
  ).catch(() => null);
  return !!(res && (res.modifiedCount === 1 || res.nModified === 1 || res.matchedCount === 1));
}

async function renewMembershipSweepLease(settings) {
  const now = new Date();
  const expiresAt = new Date(Date.now() + MEMBERSHIP_SWEEP_LEASE_MS);
  await BotSettings.updateOne(
    { _id: settings._id, membershipSweepLeaseId: MEMBERSHIP_SWEEP_LEASE_ID },
    { $set: { membershipSweepLeaseExpiresAt: expiresAt, membershipSweepLeaseUpdatedAt: now } }
  ).catch(() => {});
}

async function isUserFacingOperational(settings) {
  const [inviters, [channels, groups]] = await Promise.all([
    getInviterAccounts(settings),
    Promise.all([getMandatoryChannelIds(), getMandatoryGroupIds()]),
  ]);

  if ((channels?.length || 0) + (groups?.length || 0) < 1) return false;
  if ((inviters?.length || 0) < 1) return false;
  return true;
}

async function tryUnbanWithInviter(settings, chatIdStr, userIdStr) {
  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return false;
  const hints = await getChatLinkHintsByIds([chatIdStr]);
  const hint = hints.get(chatIdStr.toString()) || '';
  const uid = userIdStr?.toString?.() || '';
  if (!uid) return false;

  const rights = new Api.ChatBannedRights({
    untilDate: 0,
    viewMessages: false,
    sendMessages: false,
    sendMedia: false,
    sendStickers: false,
    sendGifs: false,
    sendGames: false,
    sendInline: false,
    embedLinks: false,
    sendPolls: false,
    changeInfo: false,
    inviteUsers: false,
    pinMessages: false,
    manageTopics: false,
  });

  for (let i = 0; i < inviters.length; i += 1) {
    const inviter = pickInviterAccount(inviters);
    try {
      const ok = await withInviterClient(inviter, async (client) => {
        const peer = await resolveInviterPeer(client, chatIdStr.toString(), hint);
        const user = await client.getEntity(uid).catch(() => null);
        if (!user) return false;
        await client.invoke(new Api.channels.EditBanned({ channel: peer, participant: user, bannedRights: rights }));
        return true;
      });
      if (ok) return true;
    } catch {}
  }
  return false;
}

async function ensureUserUnbannedInChats(settings, telegram, userId, chatIds) {
  const uid = userId?.toString?.() || '';
  const ids = (chatIds || []).map((c) => c?.toString?.()).filter(Boolean);
  if (!uid || !ids.length) return;
  for (const cid of ids) {
    const ok = await telegram.unbanChatMember(Number(cid), Number(uid)).then(() => true).catch(() => false);
    if (ok) continue;
    await tryUnbanWithInviter(settings, cid, uid).catch(() => {});
  }
}

function isAdminRightsError(desc = '') {
  const d = (desc || '').toString().toLowerCase();
  return d.includes('not enough rights') ||
    d.includes('chat_admin_required') ||
    d.includes('need administrator rights');
}

async function tryKickWithInviter(settings, chatIdStr, userIdStr, untilDateSec, unbanAfter = true) {
  const inviters = await getInviterAccounts(settings);
  if (!inviters.length) return false;
  const hints = await getChatLinkHintsByIds([chatIdStr]);
  const hint = hints.get(chatIdStr.toString()) || '';
  const uid = userIdStr?.toString?.() || '';
  if (!uid) return false;

  const banRights = new Api.ChatBannedRights({
    untilDate: untilDateSec || 0,
    viewMessages: true,
    sendMessages: true,
    sendMedia: true,
    sendStickers: true,
    sendGifs: true,
    sendGames: true,
    sendInline: true,
    embedLinks: true,
    sendPolls: true,
    changeInfo: true,
    inviteUsers: true,
    pinMessages: true,
    manageTopics: true,
  });

  const unbanRights = new Api.ChatBannedRights({
    untilDate: 0,
    viewMessages: false,
    sendMessages: false,
    sendMedia: false,
    sendStickers: false,
    sendGifs: false,
    sendGames: false,
    sendInline: false,
    embedLinks: false,
    sendPolls: false,
    changeInfo: false,
    inviteUsers: false,
    pinMessages: false,
    manageTopics: false,
  });

  for (let i = 0; i < inviters.length; i += 1) {
    const inviter = pickInviterAccount(inviters);
    try {
      const ok = await withInviterClient(inviter, async (client) => {
        const peer = await resolveInviterPeer(client, chatIdStr.toString(), hint);
        const user = await client.getEntity(uid).catch(() => null);
        if (!user) return false;
        await client.invoke(new Api.channels.EditBanned({ channel: peer, participant: user, bannedRights: banRights }));
        if (unbanAfter) {
          await client.invoke(new Api.channels.EditBanned({ channel: peer, participant: user, bannedRights: unbanRights })).catch(() => {});
        }
        return true;
      });
      if (ok) return true;
    } catch {}
  }
  return false;
}

const USER_COMMAND_GATE_TEXT = 'You must start the bot and have an active subscription/trial to stay in the community.';

async function hasAllMandatoryMembershipForUser(telegram, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  const channelIds = (await getMandatoryChannelIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  const groupIds = (await getMandatoryGroupIds()).map((id) => Number(id)).filter((n) => Number.isFinite(n));
  for (const cid of channelIds) {
    if (!(await isMember(telegram, cid, uid))) return false;
  }
  for (const gid of groupIds) {
    if (!(await isMember(telegram, gid, uid))) return false;
  }
  return true;
}

async function sendJoinPromptIfNeeded(ctx, settings, userDoc, missing = null) {
  const requiredChannelIds = await getMandatoryChannelIds();
  const requiredGroupIds = await getMandatoryGroupIds();
  const firstChannelId = requiredChannelIds?.[0]?.toString?.() || null;
  const firstGroupId = requiredGroupIds?.[0]?.toString?.() || null;

  if (!firstChannelId && !firstGroupId) return false;

  const needs = Array.isArray(missing) && missing.length ? missing : null;
  const neededChannelIds = needs
    ? Array.from(new Set(needs.filter(m => m?.kind === 'channel').map(m => m?.chatId?.toString?.()).filter(Boolean)))
    : (firstChannelId ? [firstChannelId] : []);
  const neededGroupIds = needs
    ? Array.from(new Set(needs.filter(m => m?.kind === 'group').map(m => m?.chatId?.toString?.()).filter(Boolean)))
    : (firstGroupId ? [firstGroupId] : []);
  const uid = Number(ctx.from?.id);
  const stillNeededChannelIds = [];
  const stillNeededGroupIds = [];
  for (const cid of neededChannelIds) {
    const n = Number(cid);
    if (!Number.isFinite(n)) continue;
    const ok = await isMember(ctx.telegram, n, uid);
    if (!ok) stillNeededChannelIds.push(cid);
  }
  for (const gid of neededGroupIds) {
    const n = Number(gid);
    if (!Number.isFinite(n)) continue;
    const ok = await isMember(ctx.telegram, n, uid);
    if (!ok) stillNeededGroupIds.push(gid);
  }
  if (!stillNeededChannelIds.length && !stillNeededGroupIds.length) {
    await finalizeOnboardingIfJoined(settings, ctx.telegram, ctx.from.id.toString()).catch(() => {});
    return true;
  }
  const chatIdsForLinks = [...stillNeededChannelIds, ...stillNeededGroupIds].filter(Boolean);

  await ensureUserUnbannedInChats(settings, ctx.telegram, ctx.from.id, chatIdsForLinks);

  if (userDoc?.joinPromptMessageId) {
    const sentAt = userDoc?.joinPromptSentAt ? new Date(userDoc.joinPromptSentAt).getTime() : 0;
    const freshWindowMs = Math.max(60 * 1000, Number(process.env.JOIN_PROMPT_RESEND_MS || 10 * 60 * 1000));
    if (sentAt && (Date.now() - sentAt) < freshWindowMs) {
      try {
        const invites = await ensureUserInviteTickets(
          settings,
          ctx.from.id.toString(),
          { chatIds: chatIdsForLinks.length ? chatIdsForLinks : [firstChannelId, firstGroupId].filter(Boolean) }
        );
        const rows = [];
        for (let i = 0; i < stillNeededGroupIds.length; i += 1) {
          const id = stillNeededGroupIds[i];
          const link = invites.groups?.[id] || null;
          if (link) rows.push([Markup.button.url(stillNeededGroupIds.length > 1 ? `Join Group ${i + 1}` : 'Join Group', link)]);
        }
        for (let i = 0; i < stillNeededChannelIds.length; i += 1) {
          const id = stillNeededChannelIds[i];
          const link = invites.channels?.[id] || null;
          if (link) rows.push([Markup.button.url(stillNeededChannelIds.length > 1 ? `Join Channel ${i + 1}` : 'Join Channel', link)]);
        }
        if (rows.length) {
          const text =
            `🔥 🦅 Quick ritual before we fly.\n\n` +
            `Join our community group + channel so I can drop job hunts where you’ll actually see them.\n` +
            `After you join, come back here — I’ll verify and switch you on.`;
          const ok = await ctx.telegram.editMessageText(
            ctx.chat.id,
            userDoc.joinPromptMessageId,
            undefined,
            text,
            { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }
          ).then(() => true).catch(() => false);
          if (ok) {
            await BotUser.updateOne(
              { _id: userDoc._id },
              { $set: { joinPromptSentAt: new Date(), onboardingGraceUntil: new Date(Date.now() + 30 * 60 * 1000) } }
            ).catch(() => {});
            return true;
          }
        }
      } catch {}
    }
    await safeDeleteMessage(ctx.telegram, ctx.chat.id, userDoc.joinPromptMessageId, 'delete_old_join_prompt');
    await BotUser.updateOne(
      { _id: userDoc._id },
      { $set: { joinPromptMessageId: null, joinPromptSentAt: null, mandatoryJoinedAt: null } }
    ).catch(() => {});
  }

  const placeholder = await ctx.reply('🔥 🦅 Forging your private join links…', { disable_web_page_preview: true }).catch(() => null);
  if (!placeholder?.message_id) return false;

  await BotUser.updateOne(
    { _id: userDoc._id },
    { $set: { joinPromptMessageId: placeholder.message_id, joinPromptSentAt: new Date(), onboardingGraceUntil: new Date(Date.now() + 30 * 60 * 1000), mandatoryJoinedAt: null } }
  ).catch(() => {});

  const invites = await ensureUserInviteTickets(
    settings,
    ctx.from.id.toString(),
    { chatIds: chatIdsForLinks.length ? chatIdsForLinks : [firstChannelId, firstGroupId].filter(Boolean) }
  );

  const rows = [];
  for (let i = 0; i < stillNeededGroupIds.length; i += 1) {
    const id = stillNeededGroupIds[i];
    const link = invites.groups?.[id] || null;
    if (link) rows.push([Markup.button.url(stillNeededGroupIds.length > 1 ? `Join Group ${i + 1}` : 'Join Group', link)]);
  }
  for (let i = 0; i < stillNeededChannelIds.length; i += 1) {
    const id = stillNeededChannelIds[i];
    const link = invites.channels?.[id] || null;
    if (link) rows.push([Markup.button.url(stillNeededChannelIds.length > 1 ? `Join Channel ${i + 1}` : 'Join Channel', link)]);
  }
  if (!rows.length) {
    await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, 'Join links are temporarily unavailable. Please try /start again in a few minutes.', { disable_web_page_preview: true }).catch(() => {});
    return false;
  }

  const text =
    `🔥 🦅 Quick ritual before we fly.\n\n` +
    `Join our community group + channel so I can drop job hunts where you’ll actually see them.\n` +
    `After you join, come back here — I’ll verify and switch you on.`;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    placeholder.message_id,
    undefined,
    text,
    { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }
  ).catch(async () => {
    const sent = await ctx.reply(text, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => null);
    if (sent?.message_id) {
      await BotUser.updateOne(
        { _id: userDoc._id },
        { $set: { joinPromptMessageId: sent.message_id, joinPromptSentAt: new Date(), onboardingGraceUntil: new Date(Date.now() + 30 * 60 * 1000), mandatoryJoinedAt: null } }
      ).catch(() => {});
    }
  });

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

  if (u.joinPromptMessageId) {
    await safeDeleteMessage(telegram, Number(userId), u.joinPromptMessageId, 'delete_join_prompt');
  }

  const res = await BotUser.updateOne(
    { userId, mandatoryJoinedAt: null },
    { $set: { mandatoryJoinedAt: new Date(), joinPromptMessageId: null, joinPromptSentAt: null, onboardingGraceUntil: null } }
  ).catch(() => null);
  const didSet = !!(res && (res.modifiedCount === 1 || res.nModified === 1));
  if (!didSet) return true;

  await maybeCreditReferralForUser(telegram, userId).catch(() => {});

  const now = Date.now();
  const trialEndsAt = u.trialEndsAt ? new Date(u.trialEndsAt).getTime() : 0;
  const subEndsAt = u.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).getTime() : 0;
  const pendingMonths = u.pendingSubscriptionMonths || 0;

  if (pendingMonths > 0) {
    await safeSendMessage(telegram, userId, '🔥 🦅 Payment received. You’re almost in.', null, 'joined_pending_notice_1');
    await safeSendMessage(telegram, userId, 'Finish joining the required chats and I’ll switch you on immediately.', null, 'joined_pending_notice_2');
    return true;
  }

  if (trialEndsAt && now < trialEndsAt) {
    const msLeft = trialEndsAt - now;
    await safeSendMessage(telegram, userId, '🔥 🦅 Wings deployed. Your trial starts now.', null, 'trial_started_notice_1');
    await safeSendMessage(
      telegram,
      userId,
      `For the next ${formatTrialTimeLeft(msLeft)}, I’ll keep hunting developer job requests and dropping the best ones into the community group.\n\nKeep checking the group — drops can land anytime.\nBefore your trial ends, I’ll send a reminder with the Pay button.`,
      null,
      'trial_started_notice_2'
    );
    return true;
  }

  if (subEndsAt && now < subEndsAt) {
    await safeSendMessage(telegram, userId, '🔥 🦅 Wings fueled. Subscription running.', null, 'sub_active_notice_1');
    await safeSendMessage(
      telegram,
      userId,
      `🔥 🦅 I’ll keep hunting developer job requests for you until ${formatHumanDate(new Date(subEndsAt))}.\n\nKeep checking the community group — drops can land anytime.`,
      null,
      'sub_active_notice_2'
    );
    return true;
  }

  await safeSendMessage(telegram, userId, '🔥 🦅 Your wings are grounded for now.', null, 'inactive_notice_1');
  await safeSendMessage(telegram, userId, 'When it’s time to renew, I’ll message you with the Pay button.', null, 'inactive_notice_2');
  return true;
}

async function maybeCreditReferralForUser(telegram, referredUserId) {
  const referral = await Referral.findOne({ referredUserId: referredUserId.toString(), status: 'pending' }).lean();
  if (!referral?.referrerUserId) return false;

  const referrer = await BotUser.findOne({ userId: referral.referrerUserId.toString() }).lean();
  if (!referrer) {
    await Referral.updateOne({ _id: referral._id, status: 'pending' }, { $set: { status: 'invalidated' } }).catch(() => {});
    return false;
  }

  const updated = await Referral.findOneAndUpdate(
    { _id: referral._id, status: 'pending' },
    { $set: { status: 'credited', creditedAt: new Date() } },
    { new: true }
  ).lean();
  if (!updated) return false;

  const inc = SUJICARDS.perReferral;
  const referrerAfter = await BotUser.findOneAndUpdate(
    { userId: referrer.userId },
    { $inc: { sujicardBalance: inc } },
    { new: true }
  ).lean();

  const referred = await BotUser.findOne({ userId: referredUserId.toString() }).lean();
  const who = referred?.username || referredUserId.toString();
  await safeSendMessage(
    telegram,
    referrer.userId,
    `🔥🦅 Referral credited: ${who} (+${inc} Sujicard)`,
    null,
    'referral_credit_notify'
  );
  return true;
}

function escHtml(s) {
  return (s ?? '')
    .toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function withoutParseMode(extra) {
  if (!extra) return {};
  const payload = { ...extra };
  delete payload.parse_mode;
  return payload;
}

async function safeEditMessageText(ctx, text, extra = null) {
  const payload = extra || {};
  try {
    await ctx.editMessageText(text, payload);
    return true;
  } catch (err) {
    if (isMessageNotModifiedError(err)) return true;
    if (isCantParseEntitiesError(err) && payload?.parse_mode) {
      await ctx.editMessageText(text, withoutParseMode(payload)).catch(() => {});
      return true;
    }
    return false;
  }
}

async function safeReply(ctx, text, extra = null) {
  const payload = extra || {};
  try {
    await ctx.reply(text, payload);
    return true;
  } catch (err) {
    if (isCantParseEntitiesError(err) && payload?.parse_mode) {
      await ctx.reply(text, withoutParseMode(payload)).catch(() => {});
      return true;
    }
    return false;
  }
}

async function replyOrEdit(ctx, text, extra = null) {
  const payload = extra || {};
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(() => {});
    if (typeof ctx.editMessageText === 'function') {
      const ok = await safeEditMessageText(ctx, text, payload);
      if (ok) return true;
    }
  }
  await safeReply(ctx, text, payload);
  return true;
}

function uiNoopKeyboard(rows) {
  const out = rows
    .map((r) =>
      r
        .map((label) => Markup.button.callback(label, 'ui_noop'))
        .filter(Boolean)
    )
    .filter((r) => r.length);
  return out.length ? Markup.inlineKeyboard(out) : {};
}

async function extendSubscriptionNow(userId, months = 1) {
  const u = await BotUser.findOne({ userId: userId.toString() }).lean();
  const currentEndMs = u?.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).getTime() : 0;
  const baseMs = Math.max(Date.now(), currentEndMs);
  const newEnd = new Date(baseMs + Math.max(1, Number(months) || 1) * BILLING.monthMs);
  await BotUser.updateOne(
    { userId: userId.toString() },
    {
      $set: { subscriptionEndsAt: newEnd, removedAt: null, expiryReminder3dSentAt: null },
      $unset: { pendingSubscriptionPaidAt: '', pendingSubscriptionMonths: '' },
    }
  ).catch(() => {});
  return newEnd;
}

async function handleBalanceCommand(ctx) {
  if (ctx.chat?.type !== 'private') return;
  const { user } = await ensureBotUser(ctx);
  const referrals = await getReferralCount(ctx.from.id.toString());
  const bal = Number(user?.sujicardBalance || 0);
  const text =
    `🔥🦅 <b>Sujini Wallet</b>\n\n` +
    `🪙 <b>Sujicards</b>: <b>${bal}</b>\n` +
    `👥 <b>Referrals</b>: <b>${referrals}</b>\n\n` +
    `Tip: share your link with <b>/ref</b> and move faster.`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`🪙 ${bal} Sujicards`, 'ui_noop'),
      Markup.button.callback(`👥 ${referrals} referrals`, 'ui_noop'),
    ],
    [
      Markup.button.callback('🔗 My referral link', 'user_ref'),
      Markup.button.callback('🏆 Leaderboard', 'user_leaderboard'),
    ],
    [
      Markup.button.callback('🪙 Pay 100 Sujicards', 'subscribe_cards'),
      Markup.button.callback('💳 Pay 100 Stars', 'subscribe_100'),
    ],
    [Markup.button.callback('« Back', 'user_home')],
  ]);
  await replyOrEdit(ctx, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
}

async function handleReferralCommand(ctx) {
  if (ctx.chat?.type !== 'private') return;
  const { user } = await ensureBotUser(ctx);
  const botUsername = await getBotPublicUsername(ctx.telegram);
  const referrals = await getReferralCount(ctx.from.id.toString());
  const bal = Number(user?.sujicardBalance || 0);
  const link = botUsername ? `https://t.me/${botUsername}?start=ref_${ctx.from.id}` : null;
  const msg =
    `🔥🦅 <b>Sujini Referral</b>\n\n` +
    `Invite developers. Earn <b>${SUJICARDS.perReferral}</b> Sujicard when they join the required chats.\n` +
    `Monthly access: <b>${SUJICARDS.monthlySubCost}</b> Sujicards or <b>100</b> Stars.\n\n` +
    (link ? `<b>Your referral link</b>\n<code>${escHtml(link)}</code>\n\n` : '') +
    `🪙 <b>Sujicards</b>: <b>${bal}</b>\n` +
    `👥 <b>Referrals</b>: <b>${referrals}</b>`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🧾 Balance', 'user_balance'),
      Markup.button.callback('🏆 Leaderboard', 'user_leaderboard'),
    ],
    [
      Markup.button.callback('🪙 Pay 100 Sujicards', 'subscribe_cards'),
      Markup.button.callback('💳 Pay 100 Stars', 'subscribe_100'),
    ],
    [Markup.button.callback('« Back', 'user_home')],
  ]);
  await replyOrEdit(ctx, msg, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
}

async function handleLeaderboardCommand(ctx) {
  if (ctx.chat?.type !== 'private') return;
  await ensureBotUser(ctx);

  const rows = await Referral.aggregate([
    { $match: { status: 'credited' } },
    { $group: { _id: '$referrerUserId', total: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: 20 },
  ]);

  if (!rows.length) {
    await ctx.reply('Leaderboard is empty for now.').catch(() => {});
    return;
  }

  const ids = rows.map(r => r?._id?.toString?.()).filter(Boolean);
  const users = await BotUser.find({ userId: { $in: ids } }, { userId: 1, username: 1 }).lean();
  const userMap = new Map(users.map(u => [u.userId.toString(), u]));

  const lines = [];
  rows.forEach((r, i) => {
    const id = r._id?.toString?.() || '';
    const u = userMap.get(id);
    const label = u?.username || id;
    lines.push(`${i + 1}. ${label} (${id}) — ${r.total}`);
  });

  const text =
    `🔥🦅 <b>Top Referrers</b>\n\n` +
    `<pre>${escHtml(lines.join('\n'))}</pre>\n` +
    `Earn <b>${SUJICARDS.perReferral}</b> Sujicard per credited referral.`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Refresh', 'user_leaderboard'),
      Markup.button.callback('🔗 My referral link', 'user_ref'),
    ],
    [
      Markup.button.callback('🧾 Balance', 'user_balance'),
      Markup.button.callback('🪙 Pay 100 Sujicards', 'subscribe_cards'),
    ],
    [Markup.button.callback('« Back', 'user_home')],
  ]);
  await replyOrEdit(ctx, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
}

async function handleUserStart(ctx) {
  const settings = await getSettings();
  if (!(await isUserFacingOperational(settings))) {
    const name = getFriendlyName(ctx.from);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Under maintenance', { show_alert: true }).catch(() => {});
    }
    await ctx.reply(`Hey ${name} 🔥🦅\n\nSujini is under maintenance right now. Try again soon.`).catch(() => {});
    return;
  }

  const { user, isNew } = await ensureBotUser(ctx);
  if (user?.bannedAt) {
    await safeSendMessage(ctx.telegram, ctx.from.id, '🚫 You are banned from using this bot.', null, 'banned_user');
    return;
  }
  await tryActivatePendingSubscription(settings, ctx.telegram, ctx.from.id).catch(() => {});
  const freshUser = await BotUser.findOne({ userId: ctx.from.id.toString() }).lean().catch(() => null);
  const currentUser = freshUser || user;

  const now = Date.now();
  const trialEndsAt = currentUser?.trialEndsAt ? new Date(currentUser.trialEndsAt).getTime() : 0;
  const subEndsAt = currentUser?.subscriptionEndsAt ? new Date(currentUser.subscriptionEndsAt).getTime() : 0;
  const hasTimeAccess = now < trialEndsAt || now < subEndsAt;
  const pendingMonths = Number(currentUser?.pendingSubscriptionMonths || 0);
  const pendingOk = pendingMonths > 0;
  const isExpired = !hasTimeAccess && !pendingOk;
  const allowJoinLinks = isNew || pendingOk;

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

  if (isExpired) {
    const ids = [...requiredChannelIds, ...requiredGroupIds].map((n) => n?.toString?.()).filter(Boolean);
    for (const cid of ids) {
      await removeUserFromChat(ctx.telegram, cid, ctx.from.id, 'start_remove_expired').catch(() => {});
    }
    const text =
      `🔥 🦅 Your access has expired.\n\n` +
      `Tap “Pay 100 Sujicards” or “Pay 100 Stars” to reactivate your subscription.`;
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🪙 Pay 100 Sujicards', 'subscribe_cards'),
        Markup.button.callback('💳 Pay 100 Stars', 'subscribe_100'),
      ],
      [
        Markup.button.callback('🧾 Balance', 'user_balance'),
        Markup.button.callback('🔗 Referral', 'user_ref'),
      ],
    ]);
    await replyOrEdit(ctx, text, { disable_web_page_preview: true, ...keyboard }).catch(() => {});
    return;
  }

  if (missing.length) {
    const name = getFriendlyName(ctx.from);
    if (isNew && allowJoinLinks) {
      await ctx.reply(
        `Hey ${name} 🔥🦅\n\n` +
          `Welcome to Sujini — the Black Phoenix scout.\n` +
          `While you focus on building, I’ll hunt developer job requests and drop the best ones into our community.`,
        { disable_web_page_preview: true }
      ).catch(() => {});
    }
    if (!allowJoinLinks) {
      const text =
        `🔥 🦅 You must be in the community chats to use Sujini.\n\n` +
        `If you were removed, rejoin, then tap /start again.\n\n` +
        `If you need fresh join links, you’ll only get them when you start a new trial or after you pay.`;
      await replyOrEdit(ctx, text, { disable_web_page_preview: true }).catch(() => {});
      return;
    }
    await sendJoinPromptIfNeeded(ctx, settings, currentUser, missing);
    return;
  }

  if (!currentUser?.mandatoryJoinedAt) {
    await finalizeOnboardingIfJoined(settings, ctx.telegram, ctx.from.id.toString()).catch(() => {});
    return;
  }

  const isTrialActive = now < trialEndsAt;
  const ends = isTrialActive ? new Date(trialEndsAt) : new Date(subEndsAt);
  const msLeft = ends.getTime() - now;
  const statusLine =
    isTrialActive
      ? `🟢 <b>Status</b>: Trial ends in <b>${escHtml(formatTrialTimeLeft(msLeft))}</b>`
      : `🟢 <b>Status</b>: Active until <b>${escHtml(formatHumanDate(ends))}</b>`;
  const text =
    `🔥🦅 <b>Sujini</b>\n\n` +
    `${statusLine}\n\n` +
    `I find developer jobs for you and tell you fast when someone needs a developer.\n` +
    `Keep checking the community group — drops can land anytime.`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🧾 Balance', 'user_balance'),
      Markup.button.callback('🔗 Referral', 'user_ref'),
    ],
    [
      Markup.button.callback('🏆 Leaderboard', 'user_leaderboard'),
      Markup.button.callback('🪙 Pay 100 Sujicards', 'subscribe_cards'),
    ],
  ]);

  await replyOrEdit(ctx, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
}

export async function handleAdminsMenu(ctx) {
  const PAGE_SIZE = 12;
  const match = ctx?.match?.[1] ? Number(ctx.match[1]) : 0;
  const page = Number.isFinite(match) && match >= 0 ? match : 0;

  const total = await Admin.countDocuments();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);

  const admins = await Admin.find({})
    .sort({ createdAt: 1 })
    .skip(safePage * PAGE_SIZE)
    .limit(PAGE_SIZE);

  let text = `👑 *Admins* (${total})\n\n`;
  admins.forEach((a, i) => {
    const idx = safePage * PAGE_SIZE + i + 1;
    text += `${idx}. ${a.username || ''} ${a.userId ? `(${a.userId})` : ''}\n`;
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('‹ Prev', `admins_page_${safePage - 1}`));
  if (safePage < pages - 1) nav.push(Markup.button.callback('Next ›', `admins_page_${safePage + 1}`));

  const rows = [];
  rows.push([Markup.button.callback('➕ Add Admin', 'add_admin')]);
  rows.push([Markup.button.callback('🗑️ Remove Admin', 'remove_admin_list')]);
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('« Back', 'back_to_main')]);

  await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  await ctx.answerCbQuery();
}

export async function handleAddAdmin(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_admin_id', data: {} });
  await replyOrEdit(ctx, '👑 *Add Admin*\n\nSend their Telegram user ID or @username:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'admins_menu')]]),
  });
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
  const PAGE_SIZE = 10;
  const match = ctx?.match?.[1] ? Number(ctx.match[1]) : 0;
  const page = Number.isFinite(match) && match >= 0 ? match : 0;

  const total = await Account.countDocuments();
  if (!total) {
    await safeEditMessageText(ctx, 'No accounts yet. Add an account from the main menu to begin.', backToMain());
    return ctx.answerCbQuery();
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);

  const accounts = await Account.find({})
    .sort({ createdAt: 1 })
    .skip(safePage * PAGE_SIZE)
    .limit(PAGE_SIZE);

  const buttons = accounts.map((acc, i) => {
    const idx = safePage * PAGE_SIZE + i + 1;
    const label = `${idx}. ${acc.username ? '@' + acc.username : acc.number} (${acc.role})`;
    return [Markup.button.callback(label, `acc_${acc._id}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('‹ Prev', `accounts_page_${safePage - 1}`));
  if (safePage < pages - 1) nav.push(Markup.button.callback('Next ›', `accounts_page_${safePage + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback('« Back', 'back_to_main')]);

  await safeEditMessageText(ctx, `📋 *Accounts* (${total})\n\nSelect an account below to manage it:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery();
}

export async function handleAccountDetail(ctx, accId) {
  const acc = await Account.findById(accId);
  if (!acc) { await ctx.answerCbQuery('Not found'); return handleAccounts(ctx); }

  const nowMs = Date.now();
  const joining = isJoinWorkerRunning(acc._id);
  const messaging = isMessageWorkerRunning(acc._id);
  const joinLeaseOk = acc.joiningLeaseExpiresAt ? (new Date(acc.joiningLeaseExpiresAt).getTime() > nowMs) : false;
  const msgLeaseOk = acc.messagingLeaseExpiresAt ? (new Date(acc.messagingLeaseExpiresAt).getTime() > nowMs) : false;
  const msgState = messaging ? '🟢' : acc.isMessaging && msgLeaseOk ? '🟡' : '🔴';
  const joinState = joining ? '🟢' : acc.isJoining && joinLeaseOk ? '🟡' : '🔴';
  const limitInfo = acc.searchLimitHit
    ? ` · limit resets: ${acc.searchLimitResetsAt?.toUTCString() || 'unknown'}`
    : '';

  const lastSeenMs = acc.listenerLastSeenAt ? new Date(acc.listenerLastSeenAt).getTime() : 0;
  const seenAgeSec = lastSeenMs ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)) : null;
  const seenAge =
    seenAgeSec == null ? 'never'
      : seenAgeSec < 60 ? `${seenAgeSec}s`
        : seenAgeSec < 3600 ? `${Math.floor(seenAgeSec / 60)}m`
          : `${Math.floor(seenAgeSec / 3600)}h`;
  const listenerInfo = acc.role === 'listener' ? ` · seen: ${seenAge}` : '';

  const text =
    `*${acc.username ? '@' + acc.username : acc.number}*\n` +
    `Role: *${acc.role}*\n` +
    `Groups: *${acc.groups.length}*${limitInfo}\n` +
    `Join/Search: ${joinState}   Listen/Preach: ${msgState}${listenerInfo}`;

  const joinBtn = joining
    ? Markup.button.callback('🔴 Stop Join/Search', `stop_join_${acc._id}`)
    : Markup.button.callback('🟢 Start Join/Search', `start_join_${acc._id}`);
  const msgBtn = messaging
    ? Markup.button.callback('🔴 Stop Listen/Preach', `stop_msg_${acc._id}`)
    : Markup.button.callback('🟢 Start Listen/Preach', `start_msg_${acc._id}`);

  await safeEditMessageText(ctx, text, {
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
  await replyOrEdit(
    ctx,
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
}

export async function handlePickAccountRole(ctx, role) {
  const session = getSession(ctx.from.id) || { step: null, data: {} };
  session.data.role = role;
  session.step = 'awaiting_number';
  setSession(ctx.from.id, session);
  await replyOrEdit(ctx, 'Send the phone number (with country code):\nExample: +1234567890', {
    ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]),
  });
}

export async function handlePhoneNumber(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const phone = ctx.message.text.trim();
  const adminId = ctx.from?.id?.toString?.() || '';
  if (adminId && getAuthClient(adminId)) {
    await ctx.reply(
      '⏳ Still sending verification code… please wait.',
      { ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]) }
    ).catch(() => {});
    return;
  }

  const existing = await Account.findOne({ number: phone });
  if (existing?.session) {
    clearSession(ctx.from.id);
    return ctx.reply(
      `⚠️ This Telegram account is already logged in as ${existing.role} (${existing.username ? '@' + existing.username : existing.number}).\n\n` +
        `It cannot be logged in again under another role. Remove it first if you really need to change its role.`,
      { ...mainMenu() }
    );
  }
  if (existing) {
    clearSession(ctx.from.id);
    return ctx.reply(
      `⚠️ This Telegram account is already added (${existing.role}).\n\nUse Accounts to manage it.`,
      { ...mainMenu() }
    );
  }

  await ctx.reply('⏳ Sending verification code...');

  const fp = randomFingerprint();
  let client = new TelegramClient(new StringSession(''), parseInt(process.env.API_ID), process.env.API_HASH, {
    useWSS: false, autoReconnect: true, timeout: 30000,
    requestRetries: 3, connectionRetries: 5,
    deviceModel: fp.deviceModel, systemVersion: fp.systemVersion,
    appVersion: fp.appVersion, langCode: fp.langCode, systemLangCode: fp.systemLangCode,
  });
  if (adminId) setAuthClient(adminId, client);

  try {
    await withTimeout(client.connect(), 45_000, 'login_connect_timeout');
    const result = await withTimeout(sendCodeWithRetry(client, phone), 45_000, 'login_send_code_timeout');
    if (!result.success) throw new Error(result.error);

    if (result.client && result.client !== client) {
      try { await client.disconnect(); } catch {}
      client = result.client;
      if (adminId) setAuthClient(adminId, client);
    }
    session.data = { ...session.data, phoneNumber: phone, phoneCodeHash: result.phoneCodeHash };
    session.step = 'awaiting_code';
    setSession(ctx.from.id, session);

    await ctx.reply('🔐 Code sent! Enter the verification code:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
  } catch (err) {
    clearSession(ctx.from.id);
    if (adminId) clearAuthClient(adminId);
    try { await client?.disconnect(); } catch {}
    await ctx.reply(`❌ Failed: ${err.message}`, mainMenu());
  }
}

export async function handleVerificationCode(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const code = ctx.message.text.trim();
  const { phoneNumber, phoneCodeHash } = session.data;
  const adminId = ctx.from?.id?.toString?.() || '';
  const client = adminId ? getAuthClient(adminId) : null;
  if (!client) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', mainMenu()); }

  await ctx.reply('⏳ Logging in...');
  if (!client.connected) await withTimeout(client.connect(), 45_000, 'login_connect_timeout');

  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber,
      phoneCodeHash,
      phoneCode: code,
    }));
    await _saveNewAccount(ctx, phoneNumber, client).catch(() => {});
  } catch (err) {
    if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      session.step = 'awaiting_password';
      setSession(ctx.from.id, session);
      return ctx.reply('🔒 2FA enabled. Send your password:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
    }
    clearSession(ctx.from.id);
    if (adminId) clearAuthClient(adminId);
    try { await client?.disconnect(); } catch {}
    return ctx.reply(`❌ Login failed: ${err.message}`, mainMenu());
  }
}

export async function handlePassword(ctx, session) {
  if (!(await requireAdmin(ctx))) return clearSession(ctx.from.id);
  const password = ctx.message.text.trim();
  const { phoneNumber } = session.data;
  const adminId = ctx.from?.id?.toString?.() || '';
  const client = adminId ? getAuthClient(adminId) : null;
  if (!client) { clearSession(ctx.from.id); return ctx.reply('Session expired. Start again.', mainMenu()); }

  await ctx.reply('⏳ Verifying password...');
  if (!client.connected) await withTimeout(client.connect(), 45_000, 'login_connect_timeout');

  try {
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password.js');
    const passwordHash = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: passwordHash }));
    await _saveNewAccount(ctx, phoneNumber, client).catch(() => {});
  } catch (err) {
    if (err.errorMessage === 'PASSWORD_HASH_INVALID') {
      return ctx.reply('❌ Wrong password. Try again:', Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'back_to_main')]]));
    }
    clearSession(ctx.from.id);
    if (adminId) clearAuthClient(adminId);
    try { await client?.disconnect(); } catch {}
    return ctx.reply(`❌ Login failed: ${err.message}`, mainMenu());
  }
}

async function _saveNewAccount(ctx, phoneNumber, client) {
  const session = getSession(ctx.from.id);
  const role = session?.data?.role || 'listener';
  clearSession(ctx.from.id);

  const me = await client.getMe();
  const roleLabel = role === 'finder' ? 'groupfinder' : role;
  const rawId = me.id?.toString?.() || phoneNumber.replace(/\D/g, '');
  const idPrefix = rawId.toString().replace(/\D/g, '').slice(0, 5) || rawId.toString().slice(0, 5);
  const desiredBase = `${roleLabel}_${idPrefix}`;
  const desiredUsername = desiredBase
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 32);

  await client
    .invoke(new Api.account.UpdateProfile({ firstName: desiredBase, lastName: '' }))
    .catch(() => {});
  if (desiredUsername && desiredUsername.length >= 5) {
    await client.invoke(new Api.account.UpdateUsername({ username: desiredUsername })).catch(() => {});
  }

  const sessionString = client.session.save();
  try { await client.disconnect(); } catch {}
  const adminId = ctx.from?.id?.toString?.() || '';
  if (adminId) clearAuthClient(adminId);

  const existing = await Account.findOne({ number: phoneNumber });
  if (existing?.session) {
    return ctx.reply(
      `⚠️ This Telegram account is already logged in as ${existing.role} (${existing.username ? '@' + existing.username : existing.number}).\n\n` +
        `It cannot be logged in again under another role. Remove it first if you really need to change its role.`,
      { ...mainMenu() }
    );
  }
  if (existing) {
    return ctx.reply(
      `⚠️ This Telegram account is already added (${existing.role}).\n\nUse Accounts to manage it.`,
      { ...mainMenu() }
    );
  }
  const shouldAutoStartJoin = role === 'finder';
  const created = await Account.create({
    number: phoneNumber,
    username: desiredUsername || me.username || null,
    userId: me.id?.toString() || null,
    session: sessionString,
    role,
    groups: [],
    isJoining: shouldAutoStartJoin,
    isMessaging: false,
  });

  const shownUsername = desiredUsername || me.username || null;
  const lines = [
    '✅ Account added!',
    `Type: ${role}`,
    `Username: ${shownUsername ? '@' + shownUsername : 'N/A'}`,
    `Phone: ${phoneNumber}`,
    shouldAutoStartJoin ? 'Auto-start: group finder running' : null,
  ].filter(Boolean);
  await ctx.reply(lines.join('\n'), { ...mainMenu() }).catch(() => {});
  if (shouldAutoStartJoin) {
    await startJoinWorker(created._id.toString()).catch(() => {});
  }
}

export async function handleTemplatesMenu(ctx) {
  const count = await MessageTemplate.countDocuments();
  await replyOrEdit(ctx, `🧾 *Templates* (${count})`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Template', 'template_add')],
      [Markup.button.callback('📋 View Templates', 'template_view')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
}

export async function handleAddTemplate(ctx) {
  if (!(await requireAdmin(ctx))) return;
  setSession(ctx.from.id, { step: 'awaiting_template_text', data: {} });
  await replyOrEdit(ctx, 'Send the template text:', {
    ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'templates_menu')]]),
  });
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
    await replyOrEdit(
      ctx,
      'No templates yet. Add one, then come back here to manage them.',
      Markup.inlineKeyboard([[Markup.button.callback('« Back', 'templates_menu')]])
    );
    return;
  }
  const buttons = templates.map(t => [Markup.button.callback(`🗑️ ${t.text.slice(0, 40) || '(empty)'}`, `del_tpl_${t._id}`)]);
  buttons.push([Markup.button.callback('« Back', 'templates_menu')]);
  await replyOrEdit(ctx, 'Tap a template below to delete it:', Markup.inlineKeyboard(buttons));
}

export async function handleDeleteTemplate(ctx, id) {
  await MessageTemplate.deleteOne({ _id: id });
  await ctx.answerCbQuery('🗑️ Deleted');
  return handleViewTemplates(ctx);
}

const KW_PAGE = 10;

export async function handleKeywordsMenu(ctx) {
  const count = await Keyword.countDocuments();
  await replyOrEdit(ctx, `🔑 *Keywords* (${count} total)`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Keywords', 'add_keywords')],
      [Markup.button.callback('📋 View Keywords', 'view_keywords_0')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
}

export async function handleAddKeywords(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_keywords', data: {} });
  await replyOrEdit(
    ctx,
    '➕ *Add Keywords*\n\nSend keywords separated by commas, or spaces if no commas:\nExample: `react, node, python`',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'keywords_menu')]]) }
  );
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
    await safeEditMessageText(ctx, 'No keywords yet. Add a few, then come back here to manage them.', Markup.inlineKeyboard([[Markup.button.callback('« Back', 'keywords_menu')]]));
    return ctx.answerCbQuery();
  }
  const keywords = await Keyword.find({}).sort({ createdAt: 1 }).skip(page * KW_PAGE).limit(KW_PAGE);
  const totalPages = Math.ceil(total / KW_PAGE);

  const buttons = keywords.map(k => [Markup.button.callback(`🗑️ ${k.word}`, `del_kw_${k._id}`)]);
  if (page > 0) buttons.push([Markup.button.callback('⬅️ Prev', `view_keywords_${page - 1}`)]);
  if (page < totalPages - 1) buttons.push([Markup.button.callback('Next ➡️', `view_keywords_${page + 1}`)]);
  buttons.push([Markup.button.callback('« Back', 'keywords_menu')]);

  await replyOrEdit(
    ctx,
    `🔑 *Keywords* (page ${page + 1}/${totalPages}, total ${total})\n_Click a keyword to delete it_`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
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

  await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
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

  await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
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
    `Send one message (text/photo/video/document/etc) and it will be copied to selected bot users (in DB) in batches.\n` +
    `Rate limit is capped at 28 messages/sec.`;

  await safeEditMessageText(ctx, text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('▶️ All users', 'broadcast_start')],
      [Markup.button.callback('🧊 Expired subscribers', 'broadcast_start_expired')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

const activeBroadcastByAdmin = new Set();

async function startBroadcastWithTarget(ctx, target) {
  if (!(await requireAdmin(ctx))) return;
  setSession(ctx.from.id, { step: 'awaiting_broadcast_message', data: { target } });
  await ctx.editMessageText(
    target === 'expired_subscribers'
      ? 'Send the message to broadcast to expired subscribers (any format).'
      : 'Send the message to broadcast (any format).',
    Markup.inlineKeyboard([[Markup.button.callback('« Cancel', 'broadcast_menu')]])
  );
  await ctx.answerCbQuery();
}

export async function handleBroadcastStart(ctx) {
  return startBroadcastWithTarget(ctx, 'all');
}

export async function handleBroadcastStartExpired(ctx) {
  return startBroadcastWithTarget(ctx, 'expired_subscribers');
}

async function runBroadcastCopy(telegram, adminId, fromChatId, messageId, target = 'all') {
  const batchSize = 500;
  let lastId = null;
  let enqueued = 0;
  let sent = 0;
  let failed = 0;
  const now = new Date();

  while (true) {
    const q = { bannedAt: null };
    if (target === 'expired_subscribers') {
      q.pendingSubscriptionMonths = { $lte: 0 };
      q.subscriptionEndsAt = { $ne: null, $lte: now };
      q.$or = [{ trialEndsAt: null }, { trialEndsAt: { $lte: now } }];
    }
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
  const label = target === 'expired_subscribers' ? 'Expired subscribers' : 'All users';
  await safeSendMessage(
    telegram,
    adminId,
    `📣 Broadcast finished (${label}).\n\nEnqueued: ${enqueued}\nSent: ${sent}\nFailed: ${failed}`,
    null,
    'broadcast_done'
  );
}

export async function handleBroadcastMessage(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const session = getSession(ctx.from?.id);
  const adminId = ctx.from.id.toString();
  if (activeBroadcastByAdmin.has(adminId)) {
    clearSession(ctx.from.id);
    return ctx.reply('⚠️ A broadcast is already running.').catch(() => {});
  }

  const fromChatId = ctx.chat.id;
  const messageId = ctx.message?.message_id;
  clearSession(ctx.from.id);
  if (!messageId) return ctx.reply('⚠️ Invalid message. Try again.').catch(() => {});
  const target = session?.data?.target || 'all';

  activeBroadcastByAdmin.add(adminId);
  await ctx.reply('✅ Broadcast started.').catch(() => {});

  runBroadcastCopy(ctx.telegram, adminId, fromChatId, messageId, target)
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
  const reviewDump = s?.reviewDumpChatId ? s.reviewDumpChatId.toString() : 'not set';
  const text =
    `⚙️ *Settings*\n\n` +
    `Mandatory channels (approved): ${channels.length}\n` +
    `Mandatory groups (approved): ${groups.length}\n` +
    `Inviter accounts selected: ${inviterIds.length}\n\n` +
    `Review dump chat: ${reviewDump}\n\n` +
    `Bot posting: ${s.botPostingEnabled ? '✅ ON' : '⛔ OFF'}\n` +
    `AI alerts: ${s.aiAlertsEnabled ? '✅ ON' : '⛔ OFF'}\n` +
    `Auto-resume workers: ${s.autoResumeWorkers ? '✅ ON' : '⛔ OFF'}`;

  await safeEditMessageText(ctx, text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('Set Inviter Accounts', 'set_inviter_account')],
      [Markup.button.callback('Pick Review Dump Group', 'review_dump_menu')],
      [Markup.button.callback('Use This Chat As Dump', 'set_review_dump_here')],
      [Markup.button.callback('Clear Review Dump', 'clear_review_dump')],
      [Markup.button.callback(s.autoResumeWorkers ? 'Disable Auto-Resume' : 'Enable Auto-Resume', 'toggle_auto_resume')],
      [Markup.button.callback(s.botPostingEnabled ? 'Disable Posting' : 'Enable Posting', 'toggle_posting')],
      [Markup.button.callback(s.aiAlertsEnabled ? 'Disable AI Alerts' : 'Enable AI Alerts', 'toggle_ai_alerts')],
      [Markup.button.callback('Flush Queue', 'flush_queue')],
      [Markup.button.callback('« Back', 'back_to_main')],
    ]),
  });
  await ctx.answerCbQuery();
}

export async function handleSetReviewDumpHere(ctx) {
  if (!(await requireAdmin(ctx))) return;
  if (ctx?.chat?.type !== 'group' && ctx?.chat?.type !== 'supergroup') {
    await ctx.answerCbQuery('Open Settings inside the dump group, or use Pick Review Dump Group');
    return handleSettingsMenu(ctx);
  }
  const chatId = ctx?.chat?.id;
  if (!chatId) { await ctx.answerCbQuery('No chat'); return handleSettingsMenu(ctx); }
  const s = await getSettings();
  s.reviewDumpChatId = chatId.toString();
  await s.save();
  await ctx.answerCbQuery('✅ Review dump set');
  return handleSettingsMenu(ctx);
}

export async function handleClearReviewDump(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  s.reviewDumpChatId = null;
  await s.save();
  await ctx.answerCbQuery('✅ Cleared');
  return handleSettingsMenu(ctx);
}

export async function handleReviewDumpMenu(ctx, page = 0) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  const selected = s?.reviewDumpChatId ? s.reviewDumpChatId.toString() : null;
  const PAGE_SIZE = 10;
  const safePage = Math.max(0, Number.isFinite(page) ? page : 0);
  const total = await BotChat.countDocuments({ type: { $ne: 'channel' } }).catch(() => 0);
  const chats = await BotChat.find({ type: { $ne: 'channel' } }, { chatId: 1, title: 1, type: 1, username: 1 })
    .sort({ createdAt: -1 })
    .skip(safePage * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean()
    .catch(() => []);

  const text =
    `🧾 *Pick Review Dump Group*\n\n` +
    `Add the bot to the group first, then it will show here.\n` +
    `Current: ${selected || 'not set'}`;

  const rows = (chats || []).map((c) => {
    const cid = c?.chatId?.toString?.() || '';
    const title = (c?.title || cid).toString();
    const mark = selected === cid ? '✅ ' : '';
    return [Markup.button.callback(`${mark}${title}`, `pick_review_dump_${cid}`)];
  });

  const nav = [];
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  if (safePage > 0) nav.push(Markup.button.callback('« Prev', `review_dump_page_${safePage - 1}`));
  if (safePage < maxPage) nav.push(Markup.button.callback('Next »', `review_dump_page_${safePage + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('« Back', 'settings_menu')]);

  await safeEditMessageText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  await ctx.answerCbQuery();
}

export async function handlePickReviewDump(ctx, chatId) {
  if (!(await requireAdmin(ctx))) return;
  const id = (chatId || '').toString().trim();
  if (!id) {
    await ctx.answerCbQuery('Not found');
    return handleReviewDumpMenu(ctx, 0);
  }
  const exists = await BotChat.exists({ chatId: id, type: { $ne: 'channel' } }).catch(() => null);
  if (!exists) {
    await ctx.answerCbQuery('Add bot to the group first');
    return handleReviewDumpMenu(ctx, 0);
  }
  const s = await getSettings();
  s.reviewDumpChatId = id;
  await s.save();
  await ctx.answerCbQuery('✅ Review dump set');
  return handleReviewDumpMenu(ctx, 0);
}

async function getJobTargetChatIdsForPosting() {
  const s = await getSettings();
  const configured = s?.jobsTargetChatId ? Number(s.jobsTargetChatId) : null;
  if (configured && Number.isFinite(configured)) return [configured];
  const rows = await ApprovedChat.find({ type: { $ne: 'channel' } }, { chatId: 1 }).lean().catch(() => []);
  return [...new Set(rows.map(r => Number(r.chatId)).filter(n => Number.isFinite(n)))];
}

async function handleReviewDecision(ctx, queueId, decision) {
  if (!(await requireAdmin(ctx))) return;
  const id = (queueId || '').toString().trim();
  if (!id) {
    await ctx.answerCbQuery('Not found');
    return;
  }

  const doc = await AiQueueMessage.findById(id).lean().catch(() => null);
  if (!doc) {
    await ctx.answerCbQuery('Not found');
    return;
  }

  const already = doc.reviewDecision;
  if (already) {
    await ctx.answerCbQuery(`Already ${already}`);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: `✅ ${already.toUpperCase()}`, callback_data: 'ui_noop' }]] }); } catch {}
    return;
  }

  const now = new Date();
  await AiQueueMessage.updateOne(
    { _id: doc._id, reviewDecision: null },
    { $set: { reviewDecision: decision, reviewDecidedBy: ctx.from.id.toString(), reviewDecidedAt: now } }
  ).catch(() => {});

  if (decision === 'approved') {
    const settings = await getSettings();
    const targets = await getJobTargetChatIdsForPosting();
    if (targets.length) {
      const payload = {
        message: doc.text,
        senderName: doc.senderName,
        senderUsername: doc.senderUsername,
        senderId: doc.senderId,
        groupId: doc.groupId || null,
        groupLink: doc.groupLink,
        messageLink: doc.messageLink,
      };

      if (settings.botPostingEnabled) {
        const out = buildCandidatePost(payload);
        for (const target of targets) {
          const groupKey = doc.chatId || doc.groupId || '';
          const txtKey = `txt:${groupKey}::${contentHash(doc.text)}::${target}`;
          const insertedTxt = await PostDedupe.create({
            key: txtKey,
            sourceChatId: doc.chatId || null,
            sourceMessageId: doc.messageId ?? null,
            targetChatId: target.toString(),
          }).then(() => true).catch(() => false);
          if (!insertedTxt) continue;

          const srcKey = `src:${doc.chatId || ''}::${doc.messageId ?? ''}::${target}`;
          if (doc.chatId && doc.messageId != null) {
            await PostDedupe.create({
              key: srcKey,
              sourceChatId: doc.chatId || null,
              sourceMessageId: doc.messageId ?? null,
              targetChatId: target.toString(),
            }).catch(() => {});
          }

          await ctx.telegram.sendMessage(target, out.text, {
            disable_web_page_preview: true,
            parse_mode: 'HTML',
            reply_markup: out.reply_markup || undefined,
          }).catch(() => {});
        }
      } else {
        await QueuedPost.create(payload).catch(() => {});
      }
    }
  }

  await ctx.answerCbQuery(decision === 'approved' ? '✅ Approved' : '⛔ Declined');
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: decision === 'approved' ? '✅ APPROVED' : '⛔ DECLINED', callback_data: 'ui_noop' }]] }); } catch {}
}

export async function handleReviewApprove(ctx, queueId) {
  return handleReviewDecision(ctx, queueId, 'approved');
}

export async function handleReviewDecline(ctx, queueId) {
  return handleReviewDecision(ctx, queueId, 'declined');
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

export async function handleToggleAutoResume(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getSettings();
  s.autoResumeWorkers = !s.autoResumeWorkers;
  await s.save();
  await ctx.answerCbQuery(s.autoResumeWorkers ? '✅ Auto-resume enabled' : '⛔ Auto-resume disabled');
  return handleSettingsMenu(ctx);
}

function formatCandidatePost(fields) {
  const lines = [];
  if (fields.senderName) lines.push(`Name: ${fields.senderName}`);
  if (fields.senderId) lines.push(`User ID: ${fields.senderId}`);
  if (fields.groupLink) lines.push(`Source Group: ${fields.groupLink}`);
  if (fields.messageLink) lines.push(`Source Message: ${fields.messageLink}`);
  if (fields.senderUsername) lines.push(`Username: ${fields.senderUsername}`);
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

  await safeEditMessageText(ctx, text, {
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
  const accounts = await Account.find({ session: { $nin: [null, ''] }, role: { $ne: 'inviter' } });
  for (const acc of accounts) {
    await startJoinWorker(acc._id);
    await startMessageWorker(acc._id);
  }
  await ctx.answerCbQuery(`▶️ Started workers for ${accounts.length} accounts`);
  return handleStart(ctx);
}

export async function handleStopAll(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const accounts = await Account.find({ role: { $ne: 'inviter' } });
  for (const acc of accounts) {
    await stopJoinWorker(acc._id);
    await stopMessageWorker(acc._id);
  }
  await ctx.answerCbQuery('⏹️ All workers stopped');
  return handleStart(ctx);
}

export async function handleToggleAll(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const anyRunning = isAnyJoinWorkerRunning() || isAnyMessageWorkerRunning();
  if (anyRunning) {
    const accounts = await Account.find({ role: { $ne: 'inviter' } });
    for (const acc of accounts) {
      await stopJoinWorker(acc._id);
      await stopMessageWorker(acc._id);
    }
    await ctx.answerCbQuery('🔴 Stopped');
    return handleStart(ctx);
  }
  if (!(await ensureOperationalPrereqs(ctx))) return;
  const accounts = await Account.find({ session: { $nin: [null, ''] }, role: { $ne: 'inviter' } });
  for (const acc of accounts) {
    await startJoinWorker(acc._id);
    await startMessageWorker(acc._id);
  }
  await ctx.answerCbQuery('🟢 Started');
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

export async function handleSubscribeWithSujicards(ctx) {
  if (ctx.chat?.type !== 'private') {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Use this in DM', { show_alert: true }).catch(() => {});
    return;
  }

  const userId = ctx.from.id.toString();
  const user = await BotUser.findOne({ userId }, { sujicardBalance: 1, bannedAt: 1 }).lean();
  if (!user) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Start the bot first: /start', { show_alert: true }).catch(() => {});
    await ctx.reply('Start the bot first: /start').catch(() => {});
    return;
  }
  if (user.bannedAt) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Banned', { show_alert: true }).catch(() => {});
    return;
  }

  const cost = SUJICARDS.monthlySubCost;
  const balance = Number(user.sujicardBalance || 0);
  if (balance < cost) {
    const missing = cost - balance;
    const msg = `Not enough Sujicards. Need ${cost}, you have ${balance} (short ${missing}).`;
    if (ctx.callbackQuery) await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
    else await ctx.reply(msg).catch(() => {});
    return;
  }

  const nonce = newNonce();
  await BotUser.updateOne(
    { userId },
    { $set: { pendingSujicardConfirmNonce: nonce, pendingSujicardConfirmExpiresAt: new Date(Date.now() + 5 * 60 * 1000) } }
  ).catch(() => {});

  const text =
    `⚠️ Confirm payment\n\n` +
    `You’re about to spend *${cost} Sujicards* for *1 month*.\n` +
    `Balance: *${balance}*`;

  if (ctx.callbackQuery?.message) {
    const extra = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(sujicardConfirmKeyboard(nonce, cost).reply_markup.inline_keyboard) };
    const ok = await safeEditMessageText(ctx, text, extra);
    if (!ok) await safeReply(ctx, text, extra);
    await ctx.answerCbQuery('Confirm?', { show_alert: false }).catch(() => {});
    return;
  }

  await safeReply(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(sujicardConfirmKeyboard(nonce, cost).reply_markup.inline_keyboard) });
}

async function handleSubscribeWithSujicardsConfirm(ctx) {
  if (ctx.chat?.type !== 'private') {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Use this in DM', { show_alert: true }).catch(() => {});
    return;
  }

  const userId = ctx.from.id.toString();
  const username = ctx.from?.username ? '@' + ctx.from.username.replace(/^@/, '') : null;

  const nonce = ctx?.match?.[1]?.toString?.() || '';
  if (ctx.callbackQuery) await ctx.answerCbQuery('⏳ Processing…', { show_alert: false }).catch(() => {});
  if (!nonce) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Expired. Tap Pay again.', { show_alert: false }).catch(() => {});
    return;
  }

  const cost = SUJICARDS.monthlySubCost;
  const now = new Date();
  const updated = await BotUser.findOneAndUpdate(
    {
      userId,
      bannedAt: null,
      sujicardBalance: { $gte: cost },
      pendingSujicardConfirmNonce: nonce,
      pendingSujicardConfirmExpiresAt: { $gt: now },
    },
    {
      $inc: { pendingSubscriptionMonths: 1, sujicardBalance: -cost },
      $set: { pendingSubscriptionPaidAt: now, lastSujicardConfirmNonce: nonce, lastSujicardConfirmAt: now, ...(username ? { username } : {}) },
      $unset: { pendingSujicardConfirmNonce: '', pendingSujicardConfirmExpiresAt: '' },
    },
    { new: true }
  ).catch(() => null);

  if (!updated) {
    const u = await BotUser.findOne({ userId }).lean().catch(() => null);
    const lastAt = u?.lastSujicardConfirmAt ? new Date(u.lastSujicardConfirmAt).getTime() : 0;
    const recentlyConfirmed = u?.lastSujicardConfirmNonce === nonce && lastAt && (Date.now() - lastAt) < 5 * 60 * 1000;
    if (!recentlyConfirmed) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('Not confirmed. Tap Pay again.', { show_alert: false }).catch(() => {});
      return;
    }

    const settings = await getSettings();
    const channelIds = await getMandatoryChannelIds();
    const groupIds = await getMandatoryGroupIds();
    await ensureUserUnbannedInChats(settings, ctx.telegram, userId, [...channelIds, ...groupIds]);
    const missingChannelIds = [];
    const missingGroupIds = [];
    for (const cid of channelIds) {
      const id = cid?.toString?.() || null;
      if (!id) continue;
      if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingChannelIds.push(id);
    }
    for (const gid of groupIds) {
      const id = gid?.toString?.() || null;
      if (!id) continue;
      if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingGroupIds.push(id);
    }

    if (!missingChannelIds.length && !missingGroupIds.length) {
      const pendingMonths = Number(u?.pendingSubscriptionMonths || 0);
      if (pendingMonths > 0) await extendSubscriptionNow(userId, pendingMonths);
      const fresh = await BotUser.findOne({ userId }).lean().catch(() => null);
      const ends = fresh?.subscriptionEndsAt ? new Date(fresh.subscriptionEndsAt) : null;
      const text = ends
        ? `🔥 🦅 Payment already confirmed.\n\nActive until ${formatHumanDate(ends)}.`
        : '🔥 🦅 Payment already confirmed.';
      if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { disable_web_page_preview: true }).catch(() => {});
      } else {
        await ctx.reply(text, { disable_web_page_preview: true }).catch(() => {});
      }
      return;
    }

    const invites = await ensureUserInviteTickets(settings, userId, { chatIds: [...missingChannelIds, ...missingGroupIds] });
    const rows = [];
    for (let i = 0; i < missingGroupIds.length; i += 1) {
      const id = missingGroupIds[i];
      const link = invites.groups?.[id] || null;
      if (link) rows.push([Markup.button.url(missingGroupIds.length > 1 ? `Join Group ${i + 1}` : 'Join Group', link)]);
    }
    for (let i = 0; i < missingChannelIds.length; i += 1) {
      const id = missingChannelIds[i];
      const link = invites.channels?.[id] || null;
      if (link) rows.push([Markup.button.url(missingChannelIds.length > 1 ? `Join Channel ${i + 1}` : 'Join Channel', link)]);
    }

    const msg =
      `🔥 🦅 Payment already confirmed.\n\n` +
      `Tap to join what you’re missing.\n` +
      `After you join, come back here — I’ll verify and switch you on.`;
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => {});
    } else {
      await ctx.reply(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => {});
    }
    return;
  }

  await Payment.create({
    userId,
    username,
    kind: 'subscription',
    currency: 'SUJICARD',
    totalAmount: cost,
    months: 1,
    invoicePayload: JSON.stringify({ userId, kind: 'subscription', method: 'sujicard' }),
    telegramPaymentChargeId: null,
    providerPaymentChargeId: null,
  }).catch(() => {});

  const settings = await getSettings();
  const channelIds = await getMandatoryChannelIds();
  const groupIds = await getMandatoryGroupIds();
  await ensureUserUnbannedInChats(settings, ctx.telegram, userId, [...channelIds, ...groupIds]);
  const missingChannelIds = [];
  const missingGroupIds = [];
  for (const cid of channelIds) {
    const id = cid?.toString?.() || null;
    if (!id) continue;
    if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingChannelIds.push(id);
  }
  for (const gid of groupIds) {
    const id = gid?.toString?.() || null;
    if (!id) continue;
    if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingGroupIds.push(id);
  }

  if (!missingChannelIds.length && !missingGroupIds.length) {
    const newEnd = await extendSubscriptionNow(userId, 1);
    const text = `🔥 🦅 Payment received (${cost} Sujicards).\n\nActive until ${formatHumanDate(newEnd)}.`;
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { disable_web_page_preview: true }).catch(() => {});
    } else {
      await ctx.reply(text, { disable_web_page_preview: true }).catch(() => {});
    }
    return;
  }

  const invites = await ensureUserInviteTickets(settings, userId, { chatIds: [...missingChannelIds, ...missingGroupIds] });
  const rows = [];
  for (let i = 0; i < missingGroupIds.length; i += 1) {
    const id = missingGroupIds[i];
    const link = invites.groups?.[id] || null;
    if (link) rows.push([Markup.button.url(missingGroupIds.length > 1 ? `Join Group ${i + 1}` : 'Join Group', link)]);
  }
  for (let i = 0; i < missingChannelIds.length; i += 1) {
    const id = missingChannelIds[i];
    const link = invites.channels?.[id] || null;
    if (link) rows.push([Markup.button.url(missingChannelIds.length > 1 ? `Join Channel ${i + 1}` : 'Join Channel', link)]);
  }

  const msg =
    `🔥 🦅 Payment received (${cost} Sujicards).\n\n` +
    `Tap to join what you’re missing.\n` +
    `After you join, come back here — I’ll verify and switch you on.`;
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => {});
  } else {
    await ctx.reply(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => {});
  }
}

async function handleSubscribeWithSujicardsCancel(ctx) {
  const nonce = ctx?.match?.[1]?.toString?.() || '';
  const userId = ctx.from?.id?.toString?.() || '';
  let matched = false;
  if (nonce && userId) {
    const res = await BotUser.updateOne(
      { userId, pendingSujicardConfirmNonce: nonce },
      { $unset: { pendingSujicardConfirmNonce: '', pendingSujicardConfirmExpiresAt: '' } }
    ).catch(() => {});
    matched = !!(res && (res.modifiedCount === 1 || res.nModified === 1 || res.matchedCount === 1));
  }
  if (!matched) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Nothing to cancel', { show_alert: false }).catch(() => {});
    return;
  }
  if (ctx.callbackQuery) await ctx.answerCbQuery('Cancelled', { show_alert: false }).catch(() => {});
  const text = 'Payment cancelled.';
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { disable_web_page_preview: true, ...pay100Keyboard() }).catch(() => {});
  } else {
    await ctx.reply(text, { disable_web_page_preview: true, ...pay100Keyboard() }).catch(() => {});
  }
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
    const channelIds = await getMandatoryChannelIds();
    const groupIds = await getMandatoryGroupIds();
    await ensureUserUnbannedInChats(settings, ctx.telegram, userId, [...channelIds, ...groupIds]);
    const missingChannelIds = [];
    const missingGroupIds = [];
    for (const cid of channelIds) {
      const id = cid?.toString?.() || null;
      if (!id) continue;
      if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingChannelIds.push(id);
    }
    for (const gid of groupIds) {
      const id = gid?.toString?.() || null;
      if (!id) continue;
      if (!(await isMember(ctx.telegram, Number(id), Number(userId)))) missingGroupIds.push(id);
    }

    if (!missingChannelIds.length && !missingGroupIds.length) {
      const newEnd = await extendSubscriptionNow(userId, 1);
      await ctx.reply(
        `🔥 🦅 Payment received (${payment.total_amount} Stars).\n\nActive until ${formatHumanDate(newEnd)}.`,
        { disable_web_page_preview: true }
      ).catch(() => {});
      return;
    }

    const invites = await ensureUserInviteTickets(settings, userId, { chatIds: [...missingChannelIds, ...missingGroupIds] });
    const rows = [];
    for (let i = 0; i < missingGroupIds.length; i += 1) {
      const id = missingGroupIds[i];
      const link = invites.groups?.[id] || null;
      if (link) rows.push([Markup.button.url(missingGroupIds.length > 1 ? `Join Group ${i + 1}` : 'Join Group', link)]);
    }
    for (let i = 0; i < missingChannelIds.length; i += 1) {
      const id = missingChannelIds[i];
      const link = invites.channels?.[id] || null;
      if (link) rows.push([Markup.button.url(missingChannelIds.length > 1 ? `Join Channel ${i + 1}` : 'Join Channel', link)]);
    }
    const msg =
      `🔥 🦅 Payment received (${payment.total_amount} Stars).\n\n` +
      `Tap to join what you’re missing.\n` +
      `After you join, come back here — I’ll verify and switch you on.`;
    await ctx.reply(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }).catch(() => {});
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

    await enforceMandatoryJoinGate(s, ctx.telegram, chatId, user, 'chat_member_join').catch(() => {});
  } catch {}
}

const scheduledUnbans = new Map();
let membershipSweepRunning = false;

function scheduleUnban(telegram, chatId, userId, delays = null) {
  const cid = chatId?.toString?.() || '';
  const uid = userId?.toString?.() || '';
  const key = cid && uid ? `${cid}:${uid}` : null;
  if (!key) return;
  if (scheduledUnbans.has(key)) return;
  scheduledUnbans.set(key, true);

  const plan = Array.isArray(delays) && delays.length ? delays : [2500, 9000, 22000];
  for (const ms of plan) {
    const t = setTimeout(() => {
      outboundQueue.enqueue(async () => {
        const ok = await telegram.unbanChatMember(Number(cid), Number(uid)).then(() => true).catch(() => false);
        if (!ok) {
          const s = await getSettings().catch(() => null);
          if (s) await tryUnbanWithInviter(s, cid, uid).catch(() => {});
        }
      });
    }, ms);
    if (t?.unref) t.unref();
  }

  const cleanup = setTimeout(() => scheduledUnbans.delete(key), Math.max(...plan) + 5000);
  if (cleanup?.unref) cleanup.unref();
}

async function removeUserFromChat(telegram, chatId, userId, context = '') {
  const out = { ok: false, desc: null };
  try {
    const m = await telegram.getChatMember(Number(chatId), Number(userId));
    const status = m?.status || null;
    if (status === 'administrator' || status === 'creator') {
      out.desc = 'Bad Request: user is an administrator of the chat';
      console.warn(`[kick] ${context} skip_admin chatId=${chatId} userId=${userId} status=${status}`);
      return out;
    }
  } catch {}
  const ctx = (context || '').toString();
  const banSeconds =
    ctx.includes('gate_') ? 10 * 60 :
    ctx.includes('sweep_remove_expired') ? 10 :
    60;
  const shouldUnbanNow = !ctx.includes('gate_');
  const untilDate = Math.floor(Date.now() / 1000) + banSeconds;

  try {
    await telegram.banChatMember(Number(chatId), Number(userId), { until_date: untilDate });
  } catch (err) {
    const { desc } = describeTelegramError(err);
    out.desc = desc;
    const s = await getSettings().catch(() => null);
    const viaInviter = s && isAdminRightsError(desc)
      ? await tryKickWithInviter(s, chatId?.toString?.() || '', userId?.toString?.() || '', untilDate, shouldUnbanNow).catch(() => false)
      : false;
    if (!viaInviter) {
      console.warn(`[kick] ${context} ban chatId=${chatId} userId=${userId} desc=${desc}`);
      return out;
    }
    out.ok = true;
    if (!shouldUnbanNow) {
      scheduleUnban(telegram, chatId, userId, [10 * 60 * 1000 + 2000]);
    }
    return out;
  }

  out.ok = true;
  if (!shouldUnbanNow) {
    scheduleUnban(telegram, chatId, userId, [10 * 60 * 1000 + 2000]);
    return out;
  }

  try {
    await telegram.unbanChatMember(Number(chatId), Number(userId));
  } catch (err) {
    const { desc } = describeTelegramError(err);
    out.desc = desc;
    console.warn(`[kick] ${context} unban chatId=${chatId} userId=${userId} desc=${desc}`);
    scheduleUnban(telegram, chatId, userId);
    return out;
  }

  return out;
}

async function membershipSweep(telegram) {
  if (membershipSweepRunning) return;
  membershipSweepRunning = true;
  const s = await getSettings();
  const requiredIds = (await getMandatoryChatIds()).filter(Boolean);
  if (!requiredIds.length) { membershipSweepRunning = false; return; }
  const hasLease = await acquireMembershipSweepLease(s);
  if (!hasLease) { membershipSweepRunning = false; return; }

  try {
    const now = Date.now();
    const users = await BotUser.find({
      $or: [
        { bannedAt: { $ne: null } },
        { pendingSubscriptionMonths: { $gt: 0 } },
        { joinPromptMessageId: { $ne: null }, mandatoryJoinedAt: null },
        { removedAt: null, bannedAt: null, pendingSubscriptionMonths: { $lte: 0 }, $or: [{ trialEndsAt: { $ne: null } }, { subscriptionEndsAt: { $ne: null } }] },
      ],
    }).lean();

    let lastRenewAt = Date.now();
    for (const u of users) {
      if (Date.now() - lastRenewAt > MEMBERSHIP_SWEEP_LEASE_MS / 2) {
        lastRenewAt = Date.now();
        await renewMembershipSweepLease(s);
      }

      if (u.bannedAt) {
        if (!u.removedAt) {
          let allRemoved = true;
          for (const cid of requiredIds) {
            const res = await removeUserFromChat(telegram, cid, u.userId, 'sweep_remove_banned');
            if (!res.ok) allRemoved = false;
          }
          if (allRemoved) {
            await BotUser.updateOne({ _id: u._id, removedAt: null }, { $set: { removedAt: new Date() } });
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
          const mark = await BotUser.updateOne(
            { _id: u._id, trialReminder8hSentAt: null },
            { $set: { trialReminder8hSentAt: new Date() } }
          ).catch(() => null);
          const did = !!(mark && (mark.modifiedCount === 1 || mark.nModified === 1));
          if (did) {
            const msg =
              `Heads up: your trial is running out (${formatTrialTimeLeft(msLeft)} left).\n\n` +
              'Tap “Pay 100 Sujicards” or “Pay 100 Stars” to stay with Sujini in the sky.';
            outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'trial_reminder_1'));
          }
        }
        if (msLeft <= BILLING.trialReminder2hMsBeforeEnd && msLeft > 0 && !u.trialReminder2hSentAt) {
          const mark = await BotUser.updateOne(
            { _id: u._id, trialReminder2hSentAt: null },
            { $set: { trialReminder2hSentAt: new Date() } }
          ).catch(() => null);
          const did = !!(mark && (mark.modifiedCount === 1 || mark.nModified === 1));
          if (did) {
            const msg =
              `Urgent: your trial ends very soon (${formatTrialTimeLeft(msLeft)} left).\n\n` +
              'Tap “Pay 100 Sujicards” or “Pay 100 Stars” to stay with Sujini in the sky.';
            outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'trial_reminder_2'));
          }
        }
      }

      if (subEnds && now < subEnds) {
        const msLeft = subEnds - now;
        if (msLeft <= BILLING.subReminder3dMsBeforeEnd && msLeft > BILLING.subReminder1dMsBeforeEnd && !u.expiryReminder3dSentAt) {
          const mark = await BotUser.updateOne(
            { _id: u._id, expiryReminder3dSentAt: null },
            { $set: { expiryReminder3dSentAt: new Date() } }
          ).catch(() => null);
          const did = !!(mark && (mark.modifiedCount === 1 || mark.nModified === 1));
          if (did) {
            const msg =
              `Your subscription ends on ${formatHumanDate(new Date(subEnds))}.\n\n` +
              'Tap “Pay 100 Sujicards” or “Pay 100 Stars” to renew and keep Sujini scouting for you.';
            outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'sub_reminder_3d'));
          }
        }
        if (msLeft <= BILLING.subReminder1dMsBeforeEnd && msLeft > 0 && !u.expiryReminder1dSentAt) {
          const mark = await BotUser.updateOne(
            { _id: u._id, expiryReminder1dSentAt: null },
            { $set: { expiryReminder1dSentAt: new Date() } }
          ).catch(() => null);
          const did = !!(mark && (mark.modifiedCount === 1 || mark.nModified === 1));
          if (did) {
            const msg =
              `⏳ 1 day left.\n\n` +
              `Your subscription ends on ${formatHumanDate(new Date(subEnds))}.\n\n` +
              'Tap “Pay 100 Sujicards” or “Pay 100 Stars” to renew and keep Sujini scouting for you.';
            outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'sub_reminder_1d'));
          }
        }
      }

      if (!active && !pending && !u.removedAt && (trialEnds || subEnds)) {
        let allRemoved = true;
        for (const cid of requiredIds) {
          const res = await removeUserFromChat(telegram, cid, u.userId, 'sweep_remove_expired');
          if (!res.ok) allRemoved = false;
        }
        if (allRemoved) {
          const mark = await BotUser.updateOne(
            { _id: u._id, removedAt: null },
            { $set: { removedAt: new Date() } }
          ).catch(() => null);
          const did = !!(mark && (mark.modifiedCount === 1 || mark.nModified === 1));
          if (did) {
            const msg =
              '🔥 🦅 Your access has expired, so you’ve been removed from the community chats.\n\n' +
              'Tap “Pay 100 Sujicards” or “Pay 100 Stars” to reactivate your subscription.';
            outboundQueue.enqueue(() => safeSendMessage(telegram, u.userId, msg, pay100Keyboard(), 'expired_removed'));
          }
        }
      }
    }
  } finally {
    membershipSweepRunning = false;
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
    if (isStaleCallbackQueryError(err) || isMessageNotModifiedError(err) || isCantParseEntitiesError(err)) return;
    try {
      if (ctx?.callbackQuery) {
        ctx.answerCbQuery('❌ Something went wrong').catch(() => {});
      }
    } catch {}
    console.error(`[Bot Error] ${err?.message || 'unknown_error'}`);
  });

  bot.use(async (ctx, next) => {
    if (!ctx?.callbackQuery) return next();
    let answered = false;
    const orig = ctx.answerCbQuery?.bind(ctx);
    if (orig) {
      ctx.answerCbQuery = async (...args) => {
        answered = true;
        try {
          return await orig(...args);
        } catch (err) {
          if (isStaleCallbackQueryError(err) || isMessageNotModifiedError(err)) return;
          throw err;
        }
      };
    }

    const timer = setTimeout(() => {
      if (answered) return;
      try {
        ctx.answerCbQuery().catch(() => {});
      } catch {}
    }, 1500);
    if (timer?.unref) timer.unref();

    try {
      return await next();
    } finally {
      clearTimeout(timer);
    }
  });

  bot.use(async (ctx, next) => {
    try {
      const msg = ctx?.message || null;
      const messageId = msg?.message_id || null;
      const chatIdStr = ctx?.chat?.id?.toString?.() || null;
      if (!msg || !messageId || !chatIdStr) return next();
      if (!isGroupChatType(ctx?.chat?.type)) return next();
      if (!isServiceSpamMessage(msg)) return next();
      await ensureApprovedChatCacheLoaded();
      const approved = approvedChatCache.groups.has(chatIdStr);
      if (!approved) return next();
      if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
        const s = await getSettings().catch(() => null);
        if (s) {
          for (const member of msg.new_chat_members) {
            await enforceMandatoryJoinGate(s, ctx.telegram, chatIdStr, member, 'service_join').catch(() => {});
          }
        }
      }
      await safeDeleteMessage(ctx.telegram, ctx.chat.id, messageId, 'delete_service_spam');
      return;
    } catch {}
    return next();
  });

  bot.use((ctx, next) => authorizedGroupMiddleware(ctx, next));

  bot.command('start', handleStart);
  bot.command('balance', handleBalanceCommand);
  bot.command('ref', handleReferralCommand);
  bot.command('leaderboard', handleLeaderboardCommand);
  bot.command('ban', handleBanCommand);
  bot.command('unban', handleUnbanCommand);
  bot.on('message', handleMessage);
  bot.on('pre_checkout_query', async (ctx) => { try { await ctx.answerPreCheckoutQuery(true); } catch {} });

  bot.action('back_to_main', handleStart);
  bot.action('ui_noop', async (ctx) => { try { await ctx.answerCbQuery('🔥🦅', { show_alert: false }); } catch {} });
  bot.action('user_home', handleUserStart);
  bot.action('user_balance', handleBalanceCommand);
  bot.action('user_ref', handleReferralCommand);
  bot.action('user_leaderboard', handleLeaderboardCommand);
  bot.action('subscribe_100', handleSubscribe);
  bot.action('subscribe_cards', handleSubscribeWithSujicards);
  bot.action(/^subscribe_cards_confirm_(.+)$/i, handleSubscribeWithSujicardsConfirm);
  bot.action(/^subscribe_cards_cancel_(.+)$/i, handleSubscribeWithSujicardsCancel);

  bot.action('accounts', handleAccounts);
  bot.action(/^accounts_page_(\d+)$/, handleAccounts);
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
  bot.action(/^admins_page_(\d+)$/, handleAdminsMenu);
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
  bot.action('broadcast_start_expired', handleBroadcastStartExpired);

  bot.action('settings_menu', handleSettingsMenu);
  bot.action('toggle_posting', handleTogglePosting);
  bot.action('toggle_ai_alerts', handleToggleAiAlerts);
  bot.action('toggle_auto_resume', handleToggleAutoResume);
  bot.action('flush_queue', handleFlushQueue);
  bot.action('set_inviter_account', handleSetInviterAccount);
  bot.action(/^pick_inviter_(.+)$/, ctx => handlePickInviterAccount(ctx, ctx.match[1]));
  bot.action('clear_inviter_account', handleClearInviterAccount);
  bot.action('set_review_dump_here', handleSetReviewDumpHere);
  bot.action('clear_review_dump', handleClearReviewDump);
  bot.action('review_dump_menu', (ctx) => handleReviewDumpMenu(ctx, 0));
  bot.action(/^review_dump_page_(\d+)$/, (ctx) => handleReviewDumpMenu(ctx, parseInt(ctx.match[1])));
  bot.action(/^pick_review_dump_(-?\d+)$/, (ctx) => handlePickReviewDump(ctx, ctx.match[1]));
  bot.action(/^review_ok_(.+)$/i, ctx => handleReviewApprove(ctx, ctx.match[1]));
  bot.action(/^review_no_(.+)$/i, ctx => handleReviewDecline(ctx, ctx.match[1]));

  bot.on('chat_member', handleChatMember);
  bot.on('my_chat_member', handleMyChatMember);

  bot.action('start_all', handleStartAll);
  bot.action('stop_all', handleStopAll);
  bot.action('toggle_all', handleToggleAll);

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
  const sweepTimer = setInterval(() => membershipSweep(telegram).catch(() => {}), 60 * 1000);
  if (sweepTimer?.unref) sweepTimer.unref();
  const ANNOUNCE_MS = 30 * 60 * 1000;
  const t = setInterval(() => announceListenerGroupsProgress(telegram).catch(() => {}), ANNOUNCE_MS);
  if (t?.unref) t.unref();
}
