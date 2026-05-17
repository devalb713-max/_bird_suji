import { Api } from 'telegram/tl/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { readFile } from 'node:fs/promises';
import { Telegram } from 'telegraf';
import { Account, Admin, ApprovedChat, BotSettings, BotChat, MessageTemplate, QueuedPost, GroupLink, AiQueueMessage } from '../models/db.js';
import {
  createClient,
  extractUsernameFromLink,
  extractInviteHash,
  sendPhotoWithTyping,
  sendWithTyping,
  sleep,
  randInt,
  isFloodError,
  getFloodSeconds,
  isSlowmodeError,
  getSlowmodeSeconds,
  isAuthError,
  isWriteForbidden,
  isMediaForbiddenError,
} from './telegram.js';
import { initGroups, getGroups, removeGroup, addGroup } from './groupRegistry.js';

const botTelegram = new Telegram(process.env.BOT_TOKEN);
let _promptTemplate = null;
let _logoBytes = null;
let _jobTargetsCache = { loadedAt: 0, ids: [] };

const FALLBACK_KEYWORDS = [
  'hiring', 'hire', 'recruit', 'recruiting',
  'looking for', 'looking to hire', 'need a', 'need an', 'need someone',
  'developer', 'dev', 'engineer', 'software engineer', 'frontend', 'backend', 'fullstack',
  'freelance', 'contract', 'gig', 'project', 'paid', 'budget', 'salary', 'rate',
  'remote', 'onsite', 'hybrid',
  'react', 'node', 'nodejs', 'nextjs', 'next.js', 'typescript', 'javascript',
  'python', 'django', 'flask', 'fastapi',
  'php', 'laravel',
  'golang', 'go developer', 'java', 'spring', 'dotnet', '.net',
  'flutter', 'react native', 'android', 'ios', 'swift', 'kotlin',
  'designer', 'ui/ux', 'product designer',
  'web3', 'solidity', 'blockchain',
];

async function getSettings() {
  const existing = await BotSettings.findOne({});
  if (existing) return existing;
  return BotSettings.create({});
}

async function getPromptTemplate() {
  if (_promptTemplate) return _promptTemplate;
  const raw = await readFile(new URL('../prompt.txt', import.meta.url), 'utf8');
  _promptTemplate = raw;
  return _promptTemplate;
}

function keywordMatchHiringIntent(text = '') {
  const lower = (text || '').toLowerCase();
  return FALLBACK_KEYWORDS.some((k) => lower.includes(k));
}

function parseTrueFalse(raw = '') {
  const t = raw.toString().trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.includes('true') && !t.includes('false')) return true;
  if (t.includes('false') && !t.includes('true')) return false;
  return null;
}

async function notifyAllAdmins(text) {
  const admins = await Admin.find({ userId: { $ne: null } }, { userId: 1 }).lean();
  const ids = [...new Set(admins.map(a => a.userId).filter(Boolean))];
  await Promise.allSettled(ids.map((id) => botTelegram.sendMessage(id, text)));
}

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`openai_http_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseTrueFalse(out);
  if (parsed == null) throw new Error('openai_parse');
  return parsed;
}

async function callOpenRouter(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`openrouter_http_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseTrueFalse(out);
  if (parsed == null) throw new Error('openrouter_parse');
  return parsed;
}

function extractJsonFromText(raw = '') {
  const s = raw.toString().trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBracket = s.indexOf('[');
  const firstBrace = s.indexOf('{');
  const start = firstBracket === -1 ? firstBrace : firstBrace === -1 ? firstBracket : Math.min(firstBracket, firstBrace);
  if (start === -1) return null;
  return s.slice(start).trim();
}

function parseBatchDecisions(raw = '') {
  const jsonText = extractJsonFromText(raw);
  if (!jsonText) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const item of parsed) {
    const id = item?.id?.toString?.() || null;
    const keep = typeof item?.keep === 'boolean' ? item.keep : typeof item?.ok === 'boolean' ? item.ok : null;
    if (!id || keep == null) continue;
    out.push({ id, keep });
  }
  return out.length ? out : null;
}

async function callOpenAIBatch(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`openai_http_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseBatchDecisions(out);
  if (!parsed) throw new Error('openai_batch_parse');
  return parsed;
}

async function callOpenRouterBatch(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`openrouter_http_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseBatchDecisions(out);
  if (!parsed) throw new Error('openrouter_batch_parse');
  return parsed;
}

async function classifyHiringIntentBatch(items) {
  const settings = await getSettings();
  const basePrompt = await getPromptTemplate();
  let rules = (basePrompt || '').toString();
  const cutoff = rules.toLowerCase().indexOf('now classify the following message');
  if (cutoff !== -1) rules = rules.slice(0, cutoff);
  rules = rules
    .replace(/^return only.*true or false.*$/gmi, '')
    .replace(/^now classify.*$/gmi, '')
    .replace(/^message:\s*"\{\{message\}\}".*$/gmi, '')
    .trim();

  const prompt =
    `You are a hiring-intent classifier for developer chat groups.\n` +
    `You will classify a batch of messages.\n\n` +
    `Return ONLY valid JSON: an array of objects like {\"id\":\"...\",\"keep\":true|false}.\n` +
    `keep=true only if the message is asking to hire/recruit/find a developer/engineer for work (full-time, freelance, gig, contract, project, one-time task).\n` +
    `Do NOT include any text outside the JSON array.\n\n` +
    `Rules & examples:\n` +
    `${rules}\n\n` +
    `Batch items (JSON):\n` +
    `${JSON.stringify(items)}\n`;

  try {
    const rows = await callOpenAIBatch(prompt);
    await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
    return { decidedBy: 'openai', rows };
  } catch {
    try {
      const rows = await callOpenRouterBatch(prompt);
      await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
      return { decidedBy: 'openrouter', rows };
    } catch {
      const updated = await BotSettings.findOneAndUpdate(
        { _id: settings._id },
        { $inc: { aiConsecutiveFails: 1 } },
        { new: true }
      );
      const fails = updated?.aiConsecutiveFails ?? 0;
      if (fails >= 10 && updated?.aiAlertsEnabled) {
        const shouldNotify =
          !updated.aiCreditsAlertedAt ||
          (Date.now() - new Date(updated.aiCreditsAlertedAt).getTime()) > 6 * 60 * 60 * 1000;
        if (shouldNotify) {
          await BotSettings.updateOne({ _id: settings._id }, { $set: { aiCreditsAlertedAt: new Date() } });
          await notifyAllAdmins('AI batch classification has failed repeatedly (possible credits exhausted). Falling back to keyword matching.');
        }
      }
      return { decidedBy: 'keyword', rows: items.map(i => ({ id: i.id, keep: keywordMatchHiringIntent(i.text) })) };
    }
  }
}

async function classifyHiringIntent(text) {
  const settings = await getSettings();
  const promptTemplate = await getPromptTemplate();
  const prompt = promptTemplate.replace('{{message}}', text);

  try {
    const ok = await callOpenAI(prompt);
    await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
    return ok;
  } catch {
    try {
      const ok = await callOpenRouter(prompt);
      await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
      return ok;
    } catch (e2) {
      const updated = await BotSettings.findOneAndUpdate(
        { _id: settings._id },
        { $inc: { aiConsecutiveFails: 1 } },
        { new: true }
      );
      const fails = updated?.aiConsecutiveFails ?? 0;
      if (fails >= 10 && updated?.aiAlertsEnabled) {
        const shouldNotify =
          !updated.aiCreditsAlertedAt ||
          (Date.now() - new Date(updated.aiCreditsAlertedAt).getTime()) > 6 * 60 * 60 * 1000;
        if (shouldNotify) {
          await BotSettings.updateOne({ _id: settings._id }, { $set: { aiCreditsAlertedAt: new Date() } });
          await notifyAllAdmins('AI classification has failed repeatedly (possible credits exhausted). Falling back to keyword matching.');
        }
      }
      return keywordMatchHiringIntent(text);
    }
  }
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

async function sendBotMessageWithRetry(chatId, text) {
  const max = 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await botTelegram.sendMessage(chatId, text, { disable_web_page_preview: true });
      return true;
    } catch (err) {
      const retryAfter = err?.parameters?.retry_after;
      const waitSec = retryAfter ? Number(retryAfter) : null;
      if (waitSec && attempt < max) {
        await sleep(waitSec * 1000);
        continue;
      }
      return false;
    }
  }
  return false;
}

let _aiBatcherStarted = false;
let _aiBatcherTimer = null;
let _aiBatcherRunning = false;

function truncateForAi(text, maxChars) {
  const s = (text || '').toString();
  if (!maxChars || s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

async function enqueueAiMessage(doc) {
  const chatId = doc?.chatId?.toString?.() || null;
  const messageId = Number.isFinite(doc?.messageId) ? doc.messageId : null;
  const filter = chatId && messageId != null ? { chatId, messageId } : null;

  const setOnInsert = {
    accountId: doc?.accountId?.toString?.() || null,
    chatId,
    messageId,
    text: (doc?.text || '').toString(),
    senderName: doc?.senderName || null,
    senderUsername: doc?.senderUsername || null,
    senderId: doc?.senderId || null,
    groupLink: doc?.groupLink || null,
    messageLink: doc?.messageLink || null,
    status: 'pending',
  };

  if (!setOnInsert.text.trim()) return;

  if (filter) {
    await AiQueueMessage.updateOne(filter, { $setOnInsert: setOnInsert }, { upsert: true }).catch(() => {});
    return;
  }

  await AiQueueMessage.create(setOnInsert).catch(() => {});
}

async function releaseStuckAiBatches() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  await AiQueueMessage.updateMany(
    { status: 'processing', lockedAt: { $lt: cutoff } },
    { $set: { status: 'pending' }, $unset: { lockedAt: 1, batchId: 1 } }
  ).catch(() => {});
}

async function claimAiBatch(batchSize, batchId) {
  const now = new Date();
  const docs = [];
  for (let i = 0; i < batchSize; i++) {
    const doc = await AiQueueMessage.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing', lockedAt: now, batchId }, $unset: { error: 1 } },
      { sort: { createdAt: 1 }, new: true }
    ).lean().catch(() => null);
    if (!doc) break;
    docs.push(doc);
  }
  return docs;
}

async function processAiBatchOnce() {
  if (_aiBatcherRunning) return;
  _aiBatcherRunning = true;
  let batchId = null;
  try {
    await releaseStuckAiBatches();

    const batchSize = Math.max(1, Math.min(200, Number(process.env.AI_BATCH_SIZE || 60)));
    batchId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const docs = await claimAiBatch(batchSize, batchId);
    if (!docs.length) return;

    const settings = await getSettings();
    const targets = await getJobTargetChatIds();

    const aiMaxChars = Math.max(200, Math.min(4000, Number(process.env.AI_BATCH_TEXT_CHARS || 1400)));
    const items = docs.map(d => ({ id: d._id.toString(), text: truncateForAi(d.text, aiMaxChars) }));
    const { decidedBy, rows } = await classifyHiringIntentBatch(items);
    const decisionMap = new Map(rows.map(r => [r.id, r.keep]));
    const decidedAt = new Date();

    for (const doc of docs) {
      const id = doc._id.toString();
      const keep = decisionMap.has(id) ? decisionMap.get(id) : keywordMatchHiringIntent(doc.text);

      if (keep) {
        if (targets.length) {
          const payload = {
            message: doc.text,
            senderName: doc.senderName,
            senderUsername: doc.senderUsername,
            senderId: doc.senderId,
            groupLink: doc.groupLink,
            messageLink: doc.messageLink,
          };

          if (settings.botPostingEnabled) {
            const out = formatCandidatePost(payload);
            let anySent = false;
            for (const target of targets) {
              const sent = await sendBotMessageWithRetry(target, out);
              if (sent) anySent = true;
            }
            if (!anySent) await QueuedPost.create(payload).catch(() => {});
          } else {
            await QueuedPost.create(payload).catch(() => {});
          }
        }
      }

      await AiQueueMessage.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'done',
            decision: keep,
            decidedBy,
            decidedAt,
            lockedAt: null,
            error: null,
          },
        }
      ).catch(() => {});
    }
  } catch (err) {
    const msg = err?.message ? err.message.toString() : 'batch_failed';
    if (batchId) {
      await AiQueueMessage.updateMany(
        { status: 'processing', batchId },
        { $set: { status: 'pending', error: msg }, $unset: { lockedAt: 1, batchId: 1 } }
      ).catch(() => {});
    }
  } finally {
    _aiBatcherRunning = false;
  }
}

function startAiBatchProcessor() {
  if (_aiBatcherStarted) return;
  _aiBatcherStarted = true;
  const intervalMs = Math.max(60_000, Number(process.env.AI_BATCH_INTERVAL_MS || 10 * 60 * 1000));
  processAiBatchOnce().catch(() => {});
  _aiBatcherTimer = setInterval(() => processAiBatchOnce().catch(() => {}), intervalMs);
  if (_aiBatcherTimer?.unref) _aiBatcherTimer.unref();
}

async function getJobTargetChatIds() {
  const stale = !_jobTargetsCache.loadedAt || (Date.now() - _jobTargetsCache.loadedAt) > 60 * 1000;
  if (!stale && Array.isArray(_jobTargetsCache.ids)) return _jobTargetsCache.ids;

  const rows = await ApprovedChat.find({ type: { $ne: 'channel' } }, { chatId: 1 }).lean();
  const ids = rows
    .map(r => Number(r.chatId))
    .filter(n => Number.isFinite(n));
  _jobTargetsCache = { loadedAt: Date.now(), ids };
  return ids;
}

async function isBotManagedChat(entityId, storedGroupId) {
  const ids = [
    entityId?.toString(),
    entityId ? `-100${entityId}` : null,
    storedGroupId || null,
  ].filter(Boolean);
  if (!ids.length) return false;
  return !!(await BotChat.exists({ chatId: { $in: ids } }));
}

async function leaveAndRemoveGroup(client, accountId, group) {
  try {
    const username = extractUsernameFromLink(group.link);
    if (username) {
      const entity = await client.getEntity(username).catch(() => null);
      if (entity) await client.invoke(new Api.channels.LeaveChannel({ channel: entity })).catch(() => {});
    }
  } catch {}
  removeGroup(accountId, group.link);
  await Account.updateOne({ _id: accountId }, { $pull: { groups: { link: group.link } } });
}

async function ensureLogoBytes() {
  if (_logoBytes) return _logoBytes;
  try {
    const buf = await readFile(new URL('../assets/images/logo.png', import.meta.url));
    _logoBytes = buf;
    return _logoBytes;
  } catch {
    return null;
  }
}

const templateRotationByAccount = new Map();

async function refreshTemplateRotation(accountId) {
  const templates = await MessageTemplate.find({}, { _id: 1, text: 1 })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();

  const items = templates
    .map(t => ({ id: t._id?.toString() || null, text: (t.text || '').toString() }))
    .filter(t => t.id && t.text.trim());

  const key = accountId.toString();
  const prev = templateRotationByAccount.get(key);
  const idx = prev?.idx || 0;
  const lastId = prev?.lastId || null;
  templateRotationByAccount.set(key, { items, idx, lastId, loadedAt: Date.now() });
  return templateRotationByAccount.get(key);
}

async function getTemplateRotation(accountId) {
  const key = accountId.toString();
  const existing = templateRotationByAccount.get(key) || null;
  const stale = !existing?.loadedAt || (Date.now() - existing.loadedAt) > 5 * 60 * 1000;
  if (!existing || stale || !Array.isArray(existing.items)) {
    return refreshTemplateRotation(accountId);
  }
  return existing;
}

async function getNextPreacherTemplate(accountId) {
  const state = await getTemplateRotation(accountId);
  const items = state?.items || [];
  if (!items.length) return null;

  let idx = state.idx || 0;
  let candidate = items[idx % items.length];
  if (items.length > 1 && candidate?.id && candidate.id === state.lastId) {
    idx++;
    candidate = items[idx % items.length];
  }

  state.idx = (idx + 1) % items.length;
  state.lastId = candidate?.id || null;
  templateRotationByAccount.set(accountId.toString(), state);
  return candidate || null;
}

async function prunePreacherOverlaps(client, accountId) {
  const meAcc = await Account.findById(accountId, 'groups role');
  if (!meAcc || meAcc.role !== 'preacher') return;

  const others = await Account.find({ role: 'preacher', _id: { $ne: accountId } }, 'groups.link');
  const taken = new Set();
  for (const acc of others) {
    for (const g of acc.groups || []) {
      if (g.link) taken.add(g.link.toLowerCase().trim());
    }
  }

  for (const g of meAcc.groups || []) {
    const key = (g.link || '').toLowerCase().trim();
    if (!key) continue;
    if (!taken.has(key)) continue;
    await leaveAndRemoveGroup(client, accountId, g);
    await sleep(3000 + Math.random() * 4000);
  }
}

async function hasOwnMessageInLast30(client, entity, myUserId) {
  try {
    const msgs = await client.getMessages(entity, { limit: 30 });
    return msgs.some(m => !m.action && (m.out === true || m.senderId?.toString() === myUserId.toString()));
  } catch (err) {
    if (isAuthError(err)) throw err;
    return false;
  }
}

async function runListener(accountId, flag) {
  startAiBatchProcessor();
  const seed = await Account.findById(accountId, 'groups');
  if (seed) initGroups(accountId, seed.groups);

  while (flag.running) {
    const account = await Account.findById(accountId);
    if (!account) { flag.running = false; return; }
    if (!account.session) { flag.running = false; return; }

    const client = createClient(account.session, accountId);
    let fatalAuthErr = null;
    const queue = [];
    let processing = false;

    const buildMessageLink = async (message) => {
      try {
        const chat = await message.getChat();
        if (chat?.username) return `https://t.me/${chat.username}/${message.id}`;
        const chatIdStr = (message.chatId || chat?.id)?.toString?.() || '';
        if (chatIdStr.startsWith('-100')) return `https://t.me/c/${chatIdStr.slice(4)}/${message.id}`;
        if (chatIdStr.startsWith('-')) return `https://t.me/c/${chatIdStr.slice(1)}/${message.id}`;
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

    const processQueue = async () => {
      if (processing) return;
      processing = true;
      try {
        while (queue.length && flag.running && !fatalAuthErr) {
          const message = queue.shift();
          if (!message) continue;
          const text = (message.text || message.message || '').trim();
          if (!text) continue;

          const sender = await message.getSender().catch(() => null);
          const senderName = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ') || null;
          const senderUsername = sender?.username ? `@${sender.username}` : null;
          const senderId = sender?.id?.toString?.() || message.senderId?.toString?.() || null;
          const groupLink = await buildGroupLink(message);
          const messageLink = await buildMessageLink(message);

          const chatId = (message.chatId || (await message.getChat().catch(() => null))?.id)?.toString?.() || null;
          const messageId = Number.isFinite(message.id) ? message.id : null;
          await enqueueAiMessage({
            accountId: accountId.toString(),
            chatId,
            messageId,
            text,
            senderName,
            senderUsername,
            senderId,
            groupLink,
            messageLink,
          });
        }
      } catch (err) {
        if (isAuthError(err)) fatalAuthErr = err;
      } finally {
        processing = false;
      }
    };

    try {
      await client.connect();
      const refreshed = client.session.save();
      if (refreshed && refreshed !== account.session) {
        await Account.updateOne({ _id: accountId }, { session: refreshed });
      }
      await client.getMe();

      client.addEventHandler(
        async (event) => {
          try {
            const message = event?.message;
            if (!message || message.out) return;
            if (!event.isGroup || event.isPrivate) return;
            queue.push(message);
            processQueue().catch(() => {});
          } catch {}
        },
        new NewMessage({ incoming: true })
      );

      while (flag.running && !fatalAuthErr) {
        await sleep(30000);
      }

    } catch (err) {
      if (isAuthError(err)) fatalAuthErr = err;
      if (isFloodError(err)) await sleep(getFloodSeconds(err) * 1000);
      else await sleep(30000);
    } finally {
      try { await client.disconnect(); } catch {}
    }

    if (fatalAuthErr) {
      await Account.updateOne({ _id: accountId }, { isMessaging: false, isJoining: false });
      flag.running = false;
      return;
    }
  }

  await Account.updateOne({ _id: accountId }, { isMessaging: false });
}

function normalizeTmeLink(link) {
  try {
    const u = new URL(link);
    return `https://t.me/${u.pathname.replace(/^\//, '').toLowerCase()}`;
  } catch {
    return (link || '').toLowerCase().trim();
  }
}

async function claimNextPreacherLink(accountId) {
  const now = new Date();
  return GroupLink.findOneAndUpdate(
    { status: 'new' },
    {
      $set: { status: 'claimed', claimedByAccountId: accountId.toString(), claimedRole: 'preacher', claimedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, new: true }
  );
}

async function markGroupLink(linkDoc, patch) {
  if (!linkDoc?._id) return;
  await GroupLink.updateOne({ _id: linkDoc._id }, { $set: patch }).catch(() => {});
}

async function getOtherPreacherLinks(exceptAccountId) {
  const accounts = await Account.find({ role: 'preacher', _id: { $ne: exceptAccountId } }, 'groups.link');
  const links = new Set();
  for (const acc of accounts) {
    for (const g of acc.groups || []) {
      if (g.link) links.add(normalizeTmeLink(g.link));
    }
  }
  return links;
}

async function joinGroupLink(client, link, retried = false) {
  try {
    const hash = extractInviteHash(link);
    if (hash) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      return { joined: true, entity: null };
    }
    const username = extractUsernameFromLink(link);
    if (!username) return { joined: false, entity: null };
    const entity = await client.getEntity(username);
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
    return { joined: true, entity };
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('USER_ALREADY_PARTICIPANT') || msg.includes('INVITE_REQUEST_SENT')) {
      return { joined: true, entity: null };
    }
    if (isFloodError(err)) {
      const secs = getFloodSeconds(err);
      if (retried || secs > 300) throw err;
      await sleep(secs * 1000);
      return joinGroupLink(client, link, true);
    }
    return { joined: false, entity: null, error: msg || 'join_failed' };
  }
}

async function runPreacher(accountId, flag) {
  const seed = await Account.findById(accountId, 'groups');
  if (seed) initGroups(accountId, seed.groups);

  while (flag.running) {
    const account = await Account.findById(accountId);
    if (!account) { flag.running = false; return; }
    if (!account.session) { flag.running = false; return; }

    const label = account.username || account.number;
    const client = createClient(account.session, accountId);

    try {
      await client.connect();
      const refreshed = client.session.save();
      if (refreshed && refreshed !== account.session) {
        await Account.updateOne({ _id: accountId }, { session: refreshed });
      }
      const me = await client.getMe();
      await client.getDialogs({ limit: 100 }).catch(() => {});

      await prunePreacherOverlaps(client, accountId);

      const logo = await ensureLogoBytes();

      while (flag.running) {
        const rotation = await getTemplateRotation(accountId);
        const groupsSnapshot = [...getGroups(accountId)];
        const canPreach = !!(rotation?.items?.length && groupsSnapshot.length);
        if (canPreach) {
          for (const group of groupsSnapshot) {
            if (!flag.running) break;

            let entity;
            try {
              const username = extractUsernameFromLink(group.link);
              if (!username) continue;
              entity = await client.getEntity(username);
            } catch (err) {
              if (isAuthError(err)) throw err;
              await sleep(2000 + Math.random() * 3000);
              continue;
            }

            if (entity.broadcast) continue;
            if (await isBotManagedChat(entity.id, group.id)) continue;

            try {
              const hasOwn = await hasOwnMessageInLast30(client, entity, me.id);
              if (hasOwn) {
                await sleep(2000 + Math.random() * 3000);
                continue;
              }
            } catch (err) {
              if (isAuthError(err)) throw err;
              await sleep(2000 + Math.random() * 3000);
              continue;
            }

            const tpl = await getNextPreacherTemplate(accountId);
            if (!tpl?.text) break;
            const text = tpl.text;

            const send = async (withLogo) => {
              if (withLogo && logo) {
                await sendPhotoWithTyping(client, entity, logo, text);
              } else {
                await sendWithTyping(client, entity, text);
              }
            };

            try {
              await send(true);
            } catch (err) {
              if (isAuthError(err)) throw err;

              if (isMediaForbiddenError(err)) {
                try { await send(false); } catch (e2) {
                  if (isAuthError(e2)) throw e2;
                  if (isWriteForbidden(e2) && !await isBotManagedChat(entity.id, group.id)) {
                    await leaveAndRemoveGroup(client, accountId, group);
                  }
                }
                await sleep(randInt(45000, 120000));
                continue;
              }

              if (isSlowmodeError(err)) {
                await sleep(getSlowmodeSeconds(err) * 1000);
                continue;
              }

              if (isWriteForbidden(err)) {
                if (!await isBotManagedChat(entity.id, group.id)) {
                  await leaveAndRemoveGroup(client, accountId, group);
                }
                await sleep(5000 + Math.random() * 5000);
                continue;
              }

              if (isFloodError(err)) {
                await sleep(getFloodSeconds(err) * 1000);
                try { await send(true); } catch {}
                await sleep(randInt(45000, 120000));
                continue;
              }
            }

            await sleep(randInt(45000, 120000));
          }
        }

        const joinBatch = 25;
        let joinedThisPhase = 0;
        const otherPreacherLinks = await getOtherPreacherLinks(accountId);

        while (flag.running) {
          const acc = await Account.findById(accountId, 'groups');
          if (!acc) { flag.running = false; break; }
          if ((acc.groups?.length || 0) >= 500) break;
          if (joinedThisPhase >= joinBatch) break;

          const linkDoc = await claimNextPreacherLink(accountId);
          if (!linkDoc) break;

          const link = normalizeTmeLink(linkDoc.normalizedLink || linkDoc.link);
          if (otherPreacherLinks.has(link)) {
            await GroupLink.deleteOne({ _id: linkDoc._id }).catch(() => {});
            await sleep(2000 + Math.random() * 3000);
            continue;
          }

          const { joined, entity: joinedEntity, error } = await joinGroupLink(client, link);
          if (!joined) {
            const nextStatus = (linkDoc.attempts || 0) >= 3 ? 'dead' : 'new';
            await markGroupLink(linkDoc, { status: nextStatus, lastError: error || 'join_failed' });
            await sleep(4000 + Math.random() * 5000);
            continue;
          }

          let resolvedEntity = joinedEntity;
          if (!resolvedEntity) {
            try {
              const uname = extractUsernameFromLink(link);
              if (uname) resolvedEntity = await client.getEntity(uname);
            } catch {}
          }

          if (resolvedEntity?.broadcast) {
            await markGroupLink(linkDoc, { status: 'dead', lastError: 'broadcast' });
            await sleep(2000 + Math.random() * 3000);
            continue;
          }

          if (resolvedEntity?.defaultBannedRights?.sendMessages) {
            try { await client.invoke(new Api.channels.LeaveChannel({ channel: resolvedEntity })); } catch {}
            await markGroupLink(linkDoc, { status: 'dead', lastError: 'cannot_send_messages' });
            await sleep(4000 + Math.random() * 5000);
            continue;
          }

          const groupInfo = resolvedEntity ? {
            id: resolvedEntity.id?.toString() || link,
            name: resolvedEntity.title || link,
            link,
          } : { id: link, name: link, link };

          await Account.updateOne({ _id: accountId }, { $addToSet: { groups: groupInfo } });
          addGroup(accountId, groupInfo);
          await markGroupLink(linkDoc, { status: 'joined', joinedByAccountId: accountId.toString(), joinedRole: 'preacher', joinedAt: new Date() });
          joinedThisPhase++;
          otherPreacherLinks.add(link);

          await sleep(15000 + Math.random() * 20000);
        }

        await prunePreacherOverlaps(client, accountId);
        await sleep(60000);
      }

      await client.disconnect();

    } catch (err) {
      try { await client.disconnect(); } catch {}
      if (isAuthError(err)) {
        await Account.updateOne({ _id: accountId }, { isMessaging: false, isJoining: false });
        flag.running = false;
        return;
      }
      if (isFloodError(err)) await sleep(getFloodSeconds(err) * 1000);
      else await sleep(30000);
    }
  }

  await Account.updateOne({ _id: accountId }, { isMessaging: false });
}

export async function runMessenger(accountId, flag) {
  const acc = await Account.findById(accountId, 'role');
  if (!acc) { flag.running = false; return; }
  if (acc.role === 'listener') return runListener(accountId, flag);
  if (acc.role === 'preacher') return runPreacher(accountId, flag);
  await Account.updateOne({ _id: accountId }, { isMessaging: false });
  flag.running = false;
}
