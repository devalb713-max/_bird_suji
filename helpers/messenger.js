import { Api } from 'telegram/tl/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Telegram } from 'telegraf';
import { Account, Admin, ApprovedChat, BotSettings, BotChat, MessageTemplate, QueuedPost, GroupLink, AiQueueMessage, PostDedupe } from '../models/db.js';
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

const LISTENER_TRACE = process.env.LISTENER_TRACE === '1';
const LISTENER_TRACE_TEXT_CHARS = Math.max(80, Math.min(2000, Number(process.env.LISTENER_TRACE_TEXT_CHARS || 700)));

//#region debug-point listener-missing-messages reporter
const DEBUG_SERVER_URL = process.env.DEBUG_SERVER_URL || null;
const DEBUG_SESSION_ID = process.env.DEBUG_SESSION_ID || 'listener-missing-messages';
const DEBUG_ENABLED = !!DEBUG_SERVER_URL;

async function dbg(event, payload) {
  if (!DEBUG_ENABLED) return;
  try {
    await fetch(DEBUG_SERVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        ts: new Date().toISOString(),
        event,
        payload,
      }),
    });
  } catch {}
}
//#endregion debug-point listener-missing-messages reporter

function truncateTraceText(value, maxChars = LISTENER_TRACE_TEXT_CHARS) {
  const s = value == null ? '' : value.toString();
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function normalizeMessageChatId(rawChatId) {
  const s = rawChatId == null ? '' : rawChatId.toString();
  if (!s) return null;
  if (s.startsWith('-100')) return `tg:${s.slice(4)}`;
  if (s.startsWith('-')) return `tg:${s.slice(1)}`;
  return s;
}

function extractGroupIdFromChatId(rawChatId) {
  const s = rawChatId == null ? '' : rawChatId.toString();
  if (!s) return null;
  return s;
}

function safeTraceStringify(value) {
  try {
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'string') return truncateTraceText(v);
      return v;
    });
  } catch {
    return '"[unserializable]"';
  }
}

function listenerTrace(event, payload) {
  if (!LISTENER_TRACE) return;
  const suffix = payload === undefined ? '' : ` ${safeTraceStringify(payload)}`;
  console.log(`[ListenerTrace] ${event}${suffix}`);
}

function llmLog(event, payload) {
  const suffix = payload === undefined ? '' : ` ${safeTraceStringify(payload)}`;
  console.log(`[LLM] ${event}${suffix}`);
}

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

function escapeHtml(value) {
  return (value ?? '').toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeRegex(value) {
  return (value ?? '').toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNameTokens({ username, firstName, lastName, fallbackUsername }) {
  const items = [
    username,
    fallbackUsername,
    firstName,
    lastName,
    [firstName, lastName].filter(Boolean).join(' '),
  ]
    .map((v) => (v ?? '').toString().trim().replace(/^@/, ''))
    .filter(Boolean);
  const uniq = [...new Set(items)];
  return uniq.filter((t) => t.length >= 4 || /[_\d]/.test(t));
}

function compileMentionRegexes(tokens) {
  const out = [];
  for (const token of tokens) {
    const allowAt = token && !token.includes(' ') && /[_\d]/.test(token);
    const pattern = token.includes(' ')
      ? token.split(/\s+/).map(escapeRegex).join('\\s+')
      : escapeRegex(token);
    out.push(new RegExp(`(^|\\W)${allowAt ? '@?' : ''}${pattern}(\\W|$)`, 'i'));
  }
  return out;
}

function canonicalInternalChatId(value) {
  const s = (value ?? '').toString();
  if (!s) return null;
  if (s.startsWith('-100')) return s.slice(4);
  if (s.startsWith('-')) return s.slice(1);
  return s;
}

function scoreJobHeuristics(textRaw = '') {
  const text = (textRaw || '').toString();
  const t = text.toLowerCase();
  const matched = [];
  let score = 0;

  const hit = (name, rx, points = 1) => {
    if (!rx.test(t)) return;
    matched.push(name);
    score += points;
  };

  hit('hiring', /\b(we'?re hiring|we are hiring|hiring now|now hiring|hiring|hire)\b/i, 3);
  hit('recruiting', /\b(recruiting|recruiter|recruitment|staffing|talent acquisition)\b/i, 2);
  hit('looking_for', /\b(looking for|seeking|in search of|need (a|an)|want (a|an))\b/i, 2);
  hit('open_roles', /\b(open position|openings|vacancy|role|position|job (opening|opportunity)?)\b/i, 2);
  hit('apply', /\b(apply|application|submit (your )?(cv|resume)|send (your )?(cv|resume)|interview)\b/i, 1);
  hit('contract_terms', /\b(contract|freelance|part[-\s]?time|full[-\s]?time|remote|hybrid|on[-\s]?site|wfh)\b/i, 1);
  hit('stack_signal', /\b(tech stack|stack|requirements|responsibilities|experience|years? of experience)\b/i, 1);
  hit('rate_money', /(\$|€|£|₦|₹)\s?\d|(\b(usd|eur|gbp|ngn|inr|cad|aud)\b)\s?\d|\b(budget|rate|salary|compensation|paid)\b/i, 2);
  hit('contact', /\b(dm|pm|reach out|contact me|telegram me|send message)\b/i, 1);

  const roleish =
    /\b(developer|engineer|frontend|backend|full[\s-]?stack|mobile|ios|android|flutter|react|node|python|django|laravel|golang|rust|devops|qa|tester|designer|product designer|ui\/ux|data engineer|ml engineer|ai engineer)\b/i;
  if (roleish.test(t) && /\b(need|looking for|seeking|hiring|recruit)\b/i.test(t)) {
    matched.push('role+need');
    score += 2;
  }

  const strongSelfPromo =
    /\b(i'?m|i am|available|open to work|seeking (a )?role|looking for (a )?job|hire me)\b/i;
  if (strongSelfPromo.test(t) && /\b(my (portfolio|cv|resume)|portfolio:|cv:|resume:)\b/i.test(t)) {
    matched.push('self_promo');
    score -= 2;
  }

  return { score, matched: [...new Set(matched)] };
}

async function maybeSendReviewDumpCandidate(doc) {
  try {
    const settings = await getSettings();
    const dumpChatId = settings?.reviewDumpChatId ? settings.reviewDumpChatId.toString() : null;
    if (!dumpChatId) return;

    const chatId = doc?.chatId?.toString?.() || null;
    const messageId = Number.isFinite(doc?.messageId) ? doc.messageId : null;
    if (!chatId || messageId == null) return;

    const existing = await AiQueueMessage.findOne({ chatId, messageId }, { _id: 1, text: 1, senderName: 1, senderUsername: 1, senderId: 1, groupId: 1, groupLink: 1, messageLink: 1, reviewSentAt: 1, reviewDecision: 1 }).lean().catch(() => null);
    if (!existing) return;
    if (existing.reviewDecision) return;
    if (existing.reviewSentAt) return;

    const { score, matched } = scoreJobHeuristics(existing.text || '');

    const payload = {
      message: existing.text,
      senderName: existing.senderName,
      senderUsername: existing.senderUsername,
      senderId: existing.senderId,
      groupId: existing.groupId || null,
      groupLink: existing.groupLink,
      messageLink: existing.messageLink,
    };
    const post = buildCandidatePost(payload);
    const header =
      `<b>🧾 Manual review (heuristics)</b>\n` +
      `<b>score</b>: <code>${score}</code>\n` +
      `<b>matched</b>: <code>${escapeHtml(matched.join(', ') || 'n/a')}</code>\n\n`;

    const approveRow = [
      { text: '✅ Approve', callback_data: `review_ok_${existing._id}` },
      { text: '⛔ Decline', callback_data: `review_no_${existing._id}` },
    ];
    const extraRows = Array.isArray(post?.reply_markup?.inline_keyboard) ? post.reply_markup.inline_keyboard : [];
    const reply_markup = { inline_keyboard: [approveRow, ...extraRows] };

    const sendOnce = async (toChatId) => {
      return botTelegram.sendMessage(toChatId, `${header}${post.text}`, {
        disable_web_page_preview: true,
        parse_mode: 'HTML',
        reply_markup,
      });
    };

    let sent = null;
    let usedDumpChatId = dumpChatId;
    try {
      sent = await sendOnce(dumpChatId);
    } catch (err) {
      const migrateTo = err?.parameters?.migrate_to_chat_id;
      if (migrateTo) {
        usedDumpChatId = migrateTo.toString();
        sent = await sendOnce(usedDumpChatId).catch(() => null);
        await BotSettings.updateOne({}, { $set: { reviewDumpChatId: usedDumpChatId } }, { upsert: true }).catch(() => {});
      } else {
        throw err;
      }
    }

    if (sent?.message_id) {
      await AiQueueMessage.updateOne(
        { _id: existing._id, reviewSentAt: null },
        {
          $set: {
            reviewScore: score,
            reviewMatched: matched,
            reviewSentAt: new Date(),
            reviewDumpChatId: usedDumpChatId,
            reviewDumpMessageId: sent.message_id,
          },
        }
      ).catch(() => {});
    }
  } catch {}
}

function normalizeForContentDedupe(text) {
  return (text ?? '')
    .toString()
    .replaceAll('\u200b', '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(text) {
  const normalized = normalizeForContentDedupe(text);
  return createHash('sha256').update(normalized).digest('hex');
}

function getOpenRouterApiKeys() {
  const keys = [
    process.env.OPENROUTER_API_KEY_1,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY,
  ]
    .map((v) => (v ?? '').toString().trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

function isOpenRouterRetryableStatus(status) {
  if (!Number.isFinite(status)) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 408) return true;
  return false;
}

function isOpenRouterKeyBadStatus(status) {
  return status === 401 || status === 402 || status === 403;
}

async function callOpenRouterWithFailover({
  prompt,
  model,
  parse,
  traceKind,
}) {
  const keys = getOpenRouterApiKeys();
  if (!keys.length) throw new Error('OPENROUTER_API_KEY_1 missing');

  const maxRetriesPerKey = 3;
  let lastErr = null;

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex];
    for (let attempt = 1; attempt <= maxRetriesPerKey; attempt++) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = Math.max(6000, Math.min(3600000, Number(process.env.OPENROUTER_TIMEOUT_MS || 3000000)));
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        llmLog('request', { provider: 'openrouter', model, endpoint: '/api/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0, keyIndex, attempt, traceKind });
        listenerTrace('llm.request', { provider: 'openrouter', model, endpoint: '/api/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0, keyIndex, attempt, traceKind });
        //#region debug-point listener-missing-messages llm.request
        await dbg('llm.request', { provider: 'openrouter', model, endpoint: '/api/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0, keyIndex, attempt, traceKind });
        //#endregion debug-point listener-missing-messages llm.request

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const status = res.status;
          const body = await res.text().catch(() => '');
          llmLog('error', { provider: 'openrouter', model, status, bodyPreview: truncateTraceText(body, 900), keyIndex, attempt, traceKind });
          const err = new Error(`openrouter_http_${status}`);
          err.status = status;
          throw err;
        }

        const data = await res.json();
        const out = data?.choices?.[0]?.message?.content ?? '';
        llmLog('response', { provider: 'openrouter', model, finish: data?.choices?.[0]?.finish_reason ?? null, contentPreview: truncateTraceText(out, 900), keyIndex, attempt, traceKind });
        listenerTrace('llm.response', { provider: 'openrouter', model, contentPreview: truncateTraceText(out, 1200), finish: data?.choices?.[0]?.finish_reason ?? null, keyIndex, attempt, traceKind, ms: Date.now() - startedAt });
        //#region debug-point listener-missing-messages llm.response
        await dbg('llm.response', { provider: 'openrouter', model, contentPreview: truncateTraceText(out, 1200), finish: data?.choices?.[0]?.finish_reason ?? null, keyIndex, attempt, traceKind, ms: Date.now() - startedAt });
        //#endregion debug-point listener-missing-messages llm.response

        const parsed = parse(out);
        if (parsed == null) throw new Error('openrouter_parse');
        llmLog('parsed', { provider: 'openrouter', model, parsedRows: Array.isArray(parsed) ? parsed.length : undefined, parsed, keyIndex, attempt, traceKind });
        listenerTrace('llm.parsed', { provider: 'openrouter', model, keyIndex, attempt, traceKind, rows: Array.isArray(parsed) ? parsed.length : undefined });
        //#region debug-point listener-missing-messages llm.parsed
        await dbg('llm.parsed', { provider: 'openrouter', model, keyIndex, attempt, traceKind, rows: Array.isArray(parsed) ? parsed.length : undefined });
        //#endregion debug-point listener-missing-messages llm.parsed
        return parsed;
      } catch (err) {
        lastErr = err;
        const status = err?.status;
        const retryAfter = err?.parameters?.retry_after;
        const retryAfterSec = retryAfter ? Number(retryAfter) : null;
        const keyBad = isOpenRouterKeyBadStatus(status);
        const retryable = !keyBad && (isOpenRouterRetryableStatus(status) || err?.name === 'AbortError' || err?.message === 'openrouter_parse');

        llmLog('attempt_failed', { provider: 'openrouter', model, keyIndex, attempt, traceKind, error: err?.message || 'openrouter_failed', status: status ?? null, keyBad, retryable });
        if (keyBad) break;
        if (!retryable || attempt >= maxRetriesPerKey) break;

        const backoffMs = retryAfterSec
          ? Math.min(60000, Math.max(1000, retryAfterSec * 1000))
          : Math.min(8000, 500 * (2 ** (attempt - 1)) + randInt(0, 350));
        await sleep(backoffMs);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  throw lastErr || new Error('openrouter_failed');
}

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  llmLog('request', { provider: 'openai', model, endpoint: '/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0 });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    llmLog('error', { provider: 'openai', model, status: res.status, bodyPreview: truncateTraceText(body, 900) });
    throw new Error(`openai_http_${res.status}`);
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseTrueFalse(out);
  llmLog('response', { provider: 'openai', model, finish: data?.choices?.[0]?.finish_reason ?? null, contentPreview: truncateTraceText(out, 900), parsed });
  if (parsed == null) throw new Error('openai_parse');
  return parsed;
}

async function callOpenRouter(prompt) {
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
  const out = await callOpenRouterWithFailover({
    prompt,
    model,
    parse: (raw) => parseTrueFalse(raw),
    traceKind: 'single',
  });
  if (out == null) throw new Error('openrouter_parse');
  return out;
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
  listenerTrace('llm.request', { provider: 'openai', model, endpoint: '/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0 });
  //#region debug-point listener-missing-messages llm.request
  await dbg('llm.request', { provider: 'openai', model, endpoint: '/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0 });
  //#endregion debug-point listener-missing-messages llm.request
  llmLog('request', { provider: 'openai', model, endpoint: '/v1/chat/completions', temperature: 0, promptChars: prompt?.length ?? 0, traceKind: 'batch' });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    llmLog('error', { provider: 'openai', model, status: res.status, bodyPreview: truncateTraceText(body, 900), traceKind: 'batch' });
    throw new Error(`openai_http_${res.status}`);
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content ?? '';
  listenerTrace('llm.response', { provider: 'openai', model, contentPreview: truncateTraceText(out, 1200), finish: data?.choices?.[0]?.finish_reason ?? null });
  //#region debug-point listener-missing-messages llm.response
  await dbg('llm.response', { provider: 'openai', model, contentPreview: truncateTraceText(out, 1200), finish: data?.choices?.[0]?.finish_reason ?? null });
  //#endregion debug-point listener-missing-messages llm.response
  const parsed = parseBatchDecisions(out);
  llmLog('response', { provider: 'openai', model, finish: data?.choices?.[0]?.finish_reason ?? null, contentPreview: truncateTraceText(out, 900), parsedRows: parsed?.length ?? 0, traceKind: 'batch' });
  if (!parsed) throw new Error('openai_batch_parse');
  listenerTrace('llm.parsed', { provider: 'openai', rows: parsed.length });
  //#region debug-point listener-missing-messages llm.parsed
  await dbg('llm.parsed', { provider: 'openai', rows: parsed.length });
  //#endregion debug-point listener-missing-messages llm.parsed
  return parsed;
}

async function callOpenRouterBatch(prompt) {
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
  const out = await callOpenRouterWithFailover({
    prompt,
    model,
    parse: (raw) => parseBatchDecisions(raw),
    traceKind: 'batch',
  });
  if (!out) throw new Error('openrouter_batch_parse');
  return out;
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

  listenerTrace('ai.batch', {
    items: items.map(i => ({ id: i.id, text: truncateTraceText(i.text, 240) })),
    itemsCount: items.length,
    promptChars: prompt.length,
  });
  //#region debug-point listener-missing-messages ai.batch
  await dbg('ai.batch', {
    items: items.map(i => ({ id: i.id, text: truncateTraceText(i.text, 240) })),
    itemsCount: items.length,
    promptChars: prompt.length,
  });
  //#endregion debug-point listener-missing-messages ai.batch
  try {
    const rows = await callOpenAIBatch(prompt);
    await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
    llmLog('batch.decided', { decidedBy: 'openai', rows: rows.length, kept: rows.filter(r => r.keep).length });
    return { decidedBy: 'openai', rows };
  } catch (e1) {
    llmLog('batch.provider_failed', { provider: 'openai', error: e1?.message || 'openai_failed' });
    try {
      const rows = await callOpenRouterBatch(prompt);
      await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
      llmLog('batch.decided', { decidedBy: 'openrouter', rows: rows.length, kept: rows.filter(r => r.keep).length });
      return { decidedBy: 'openrouter', rows };
    } catch (err) {
      llmLog('batch.provider_failed', { provider: 'openrouter', error: err?.message || 'openrouter_failed' });
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
          await notifyAllAdmins('AI batch classification has failed repeatedly (OpenAI + OpenRouter). No keyword fallback is enabled, so job posts are paused until a provider recovers / credits are restored.');
        }
      }
      throw err;
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
  } catch (err) {
    try {
      const ok = await callOpenRouter(prompt);
      await BotSettings.updateOne({ _id: settings._id }, { $set: { aiConsecutiveFails: 0 } });
      return ok;
    } catch (err2) {
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
          await notifyAllAdmins('AI classification has failed repeatedly (OpenAI + OpenRouter). No keyword fallback is enabled, so job posts are paused until a provider recovers / credits are restored.');
        }
      }
      throw err2;
    }
  }
}

function formatCandidatePost(fields) {
  const lines = [];
  if (fields.senderName) lines.push(`Name: ${fields.senderName}`);
  if (fields.senderId) lines.push(`User ID: ${fields.senderId}`);
  if (fields.senderUsername) lines.push(`Username: ${fields.senderUsername}`);
  const suffix = lines.length ? `\n\n${lines.map(escapeHtml).join('\n')}` : '';
  return `<blockquote>${escapeHtml(fields.message)}</blockquote>${suffix}`;
}

function buildCandidateButtons(fields) {
  const rows = [];

  const senderId = fields?.senderId ? fields.senderId.toString().trim() : '';
  if (senderId) rows.push([{ text: '👤 Contact', url: `tg://user?id=${senderId}` }]);

  const uname = fields?.senderUsername ? fields.senderUsername.toString().trim().replace(/^@/, '') : '';
  if (uname) rows.push([{ text: `@${uname}`, url: `https://t.me/${uname}` }]);

  const messageLink = fields?.messageLink ? fields.messageLink.toString().trim() : '';
  if (messageLink) rows.push([{ text: '💬 Message', url: messageLink }]);

  const groupLink = fields?.groupLink ? fields.groupLink.toString().trim() : '';
  if (groupLink) rows.push([{ text: '👥 Group', url: groupLink }]);

  if (!rows.length) return null;
  return { inline_keyboard: rows };
}

export function buildCandidatePost(fields) {
  const text = formatCandidatePost(fields);
  const reply_markup = buildCandidateButtons(fields);
  return { text, reply_markup };
}

async function sendBotMessageWithRetry(chatId, text, reply_markup = null) {
  const max = 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await botTelegram.sendMessage(chatId, text, { disable_web_page_preview: true, parse_mode: 'HTML', reply_markup: reply_markup || undefined });
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

async function setClientOnline(client) {
  try {
    await client.invoke(new Api.account.UpdateStatus({ offline: false }));
  } catch {}
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
    groupId: doc?.groupId || null,
    groupLink: doc?.groupLink || null,
    messageLink: doc?.messageLink || null,
    status: 'pending',
  };

  if (!setOnInsert.text.trim()) return;

  if (filter) {
    await AiQueueMessage.updateOne(filter, { $setOnInsert: setOnInsert }, { upsert: true }).catch(() => {});
    listenerTrace('queue.enqueue', { chatId, messageId, textPreview: truncateTraceText(setOnInsert.text, 180) });
    //#region debug-point listener-missing-messages queue.enqueue
    await dbg('queue.enqueue', { chatId, messageId, textPreview: truncateTraceText(setOnInsert.text, 220) });
    //#endregion debug-point listener-missing-messages queue.enqueue
    return;
  }

  await AiQueueMessage.create(setOnInsert).catch(() => {});
  listenerTrace('queue.enqueue', { chatId, messageId: null, textPreview: truncateTraceText(setOnInsert.text, 180) });
  //#region debug-point listener-missing-messages queue.enqueue
  await dbg('queue.enqueue', { chatId, messageId: null, textPreview: truncateTraceText(setOnInsert.text, 220) });
  //#endregion debug-point listener-missing-messages queue.enqueue
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
    listenerTrace('queue.claimed', { batchId, docs: docs.length, targets: targets.length, botPostingEnabled: !!settings.botPostingEnabled });
    //#region debug-point listener-missing-messages queue.claimed
    await dbg('queue.claimed', { batchId, docs: docs.length, targets: targets.length, botPostingEnabled: !!settings.botPostingEnabled });
    //#endregion debug-point listener-missing-messages queue.claimed

    const aiMaxChars = Math.max(200, Math.min(4000, Number(process.env.AI_BATCH_TEXT_CHARS || 1400)));
    const items = docs.map(d => ({ id: d._id.toString(), text: truncateForAi(d.text, aiMaxChars) }));
    const { decidedBy, rows } = await classifyHiringIntentBatch(items);
    const decisionMap = new Map(rows.map(r => [r.id, r.keep]));
    const decidedAt = new Date();
    const kept = rows.filter(r => r.keep).length;
    listenerTrace('ai.decisions', { batchId, decidedBy, rows: rows.length, kept });
    //#region debug-point listener-missing-messages ai.decisions
    await dbg('ai.decisions', { batchId, decidedBy, rows: rows.length, kept });
    //#endregion debug-point listener-missing-messages ai.decisions

    for (const doc of docs) {
      const id = doc._id.toString();
      const keep = decisionMap.has(id) ? decisionMap.get(id) : false;

      if (keep) {
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
            let anySent = false;
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

              const sent = await sendBotMessageWithRetry(target, out.text, out.reply_markup);
              if (sent) anySent = true;
            }
            listenerTrace('post.attempt', { batchId, decidedBy, keep: true, targets: targets.length, sentAny: anySent, messageId: doc.messageId ?? null, chatId: doc.chatId ?? null });
            //#region debug-point listener-missing-messages post.attempt
            await dbg('post.attempt', { batchId, decidedBy, keep: true, targets: targets.length, sentAny: anySent, messageId: doc.messageId ?? null, chatId: doc.chatId ?? null });
            //#endregion debug-point listener-missing-messages post.attempt
            if (!anySent) await QueuedPost.create(payload).catch(() => {});
          } else {
            listenerTrace('post.queued', { batchId, decidedBy, keep: true, botPostingEnabled: false, messageId: doc.messageId ?? null, chatId: doc.chatId ?? null });
            //#region debug-point listener-missing-messages post.queued
            await dbg('post.queued', { batchId, decidedBy, keep: true, botPostingEnabled: false, messageId: doc.messageId ?? null, chatId: doc.chatId ?? null });
            //#endregion debug-point listener-missing-messages post.queued
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
  const intervalMs = Math.max(10_000, Number(process.env.AI_BATCH_INTERVAL_MS || 10 * 60 * 1000));
  processAiBatchOnce().catch(() => {});
  _aiBatcherTimer = setInterval(() => processAiBatchOnce().catch(() => {}), intervalMs);
  if (_aiBatcherTimer?.unref) _aiBatcherTimer.unref();
}

async function getJobTargetChatIds() {
  const stale = !_jobTargetsCache.loadedAt || (Date.now() - _jobTargetsCache.loadedAt) > 60 * 1000;
  if (!stale && Array.isArray(_jobTargetsCache.ids)) return _jobTargetsCache.ids;

  const settings = await getSettings();
  const configured = settings?.jobsTargetChatId ? Number(settings.jobsTargetChatId) : null;
  if (configured && Number.isFinite(configured)) {
    _jobTargetsCache = { loadedAt: Date.now(), ids: [configured] };
    return _jobTargetsCache.ids;
  }

  const rows = await ApprovedChat.find({ type: { $ne: 'channel' } }, { chatId: 1 }).lean();
  const ids = [...new Set(rows.map(r => Number(r.chatId)).filter(n => Number.isFinite(n)))];
  _jobTargetsCache = { loadedAt: Date.now(), ids };
  return ids;
}

async function isBotManagedChat(entityId, storedGroupId) {
  const ids = [
    entityId?.toString(),
    entityId ? `-100${entityId}` : null,
    entityId ? `-${entityId}` : null,
    storedGroupId || null,
  ].filter(Boolean);
  if (!ids.length) return false;
  return !!(await BotChat.exists({ chatId: { $in: ids } }));
}

let _approvedBotGroupIdsCache = { loadedAt: 0, ids: new Set() };
let _approvedBotGroupLinksCache = { loadedAt: 0, links: new Set() };

async function getApprovedBotGroupIds() {
  const stale = !_approvedBotGroupIdsCache.loadedAt || (Date.now() - _approvedBotGroupIdsCache.loadedAt) > 60 * 1000;
  if (!stale && _approvedBotGroupIdsCache.ids?.size) return _approvedBotGroupIdsCache.ids;

  const rows = await ApprovedChat.find({ type: 'group' }, { chatId: 1 }).lean().catch(() => []);
  const ids = new Set(rows.map(r => (r?.chatId || '').toString()).filter(Boolean));
  _approvedBotGroupIdsCache = { loadedAt: Date.now(), ids };
  return ids;
}

async function getApprovedBotGroupLinks() {
  const stale = !_approvedBotGroupLinksCache.loadedAt || (Date.now() - _approvedBotGroupLinksCache.loadedAt) > 60 * 1000;
  if (!stale && _approvedBotGroupLinksCache.links?.size) return _approvedBotGroupLinksCache.links;

  const [settings, rows] = await Promise.all([
    BotSettings.findOne({}, { requiredGroupInviteLink: 1 }).lean().catch(() => null),
    ApprovedChat.find({ type: 'group', inviteLink: { $nin: [null, ''] } }, { inviteLink: 1 }).lean().catch(() => []),
  ]);

  const links = new Set();
  const required = settings?.requiredGroupInviteLink ? normalizeTmeLink(settings.requiredGroupInviteLink) : '';
  if (required) links.add(required);
  for (const r of rows || []) {
    const l = r?.inviteLink ? normalizeTmeLink(r.inviteLink) : '';
    if (l) links.add(l);
  }

  _approvedBotGroupLinksCache = { loadedAt: Date.now(), links };
  return links;
}

async function isApprovedBotGroupChat(entityId, storedGroupId, link) {
  const ids = [
    entityId?.toString(),
    entityId ? `-${entityId}` : null,
    entityId ? `-100${entityId}` : null,
    storedGroupId?.toString?.() || null,
  ].filter(Boolean);

  const idSet = await getApprovedBotGroupIds();
  if (ids.some((x) => idSet.has(x))) return true;

  const l = link ? normalizeTmeLink(link) : '';
  if (!l) return false;
  const linkSet = await getApprovedBotGroupLinks();
  return linkSet.has(l);
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

  const others = await Account.find(
    { role: { $in: ['preacher', 'listener'] }, _id: { $ne: accountId } },
    'groups.link groups.normalizedLink'
  );
  const taken = new Set();
  for (const acc of others) {
    for (const g of acc.groups || []) {
      const key = (g.normalizedLink || g.link || '').toLowerCase().trim();
      if (key) taken.add(key);
    }
  }

  for (const g of meAcc.groups || []) {
    const key = (g.normalizedLink || g.link || '').toLowerCase().trim();
    if (!key) continue;
    if (await isApprovedBotGroupChat(null, g.id, g.link)) continue;
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
    let lastListenerEventAt = Date.now();
    let lastDbSeenAt = 0;
    let lastDialogsWarmAt = 0;
    const KEEPALIVE_MS = Math.max(20_000, Number(process.env.LISTENER_KEEPALIVE_MS || 60_000));
    const DIALOGS_WARM_MS = Math.max(20_000, Number(process.env.LISTENER_DIALOGS_WARM_MS || 60_000));
    const RECONNECT_IDLE_MS = Math.max(2 * 60_000, Number(process.env.LISTENER_RECONNECT_IDLE_MS || 12 * 60_000));
    const MAX_QUEUE = Math.max(50, Number(process.env.LISTENER_MAX_QUEUE || 300));

    const markListenerConnected = async () => {
      await Account.updateOne(
        { _id: accountId },
        { $set: { listenerConnectedAt: new Date(), listenerLastError: null } }
      ).catch(() => {});
    };

    const markListenerSeen = async ({ chatId, messageId }) => {
      const nowMs = Date.now();
      if (nowMs - lastDbSeenAt < 15000) return;
      lastDbSeenAt = nowMs;
      await Account.updateOne(
        { _id: accountId },
        {
          $set: {
            listenerLastSeenAt: new Date(),
            listenerLastChatId: chatId ? chatId.toString() : null,
            listenerLastMessageId: messageId ?? null,
          },
        }
      ).catch(() => {});
    };

    const getBestKnownGroupJoinLink = (rawChatId) => {
      const s = rawChatId == null ? '' : rawChatId.toString();
      if (!s) return null;
      const internal = s.startsWith('-100') ? s.slice(4) : s.startsWith('-') ? s.slice(1) : s;
      const groups = getGroups(accountId) || [];
      const hit = groups.find(g => {
        const id = g?.id?.toString?.() || '';
        if (!id) return false;
        return id === internal || id === s || id === `-100${internal}` || id === `-${internal}`;
      });
      const link = hit?.link ? hit.link.toString() : null;
      return link || null;
    };

    const buildGroupLink = (chat, rawChatId) => {
      const uname = chat?.username ? chat.username.toString().trim() : '';
      if (uname) return `https://t.me/${uname.replace(/^@/, '')}`;
      return getBestKnownGroupJoinLink(rawChatId);
    };

    const buildMessageLink = (chat, rawChatId, messageId) => {
      if (!messageId) return null;
      const uname = chat?.username ? chat.username.toString().trim() : '';
      if (uname) return `https://t.me/${uname.replace(/^@/, '')}/${messageId}`;
      const s = rawChatId == null ? '' : rawChatId.toString();
      if (!s.startsWith('-100')) return null;
      return `https://t.me/c/${s.slice(4)}/${messageId}`;
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
          const chat = await message.getChat().catch(() => null);
          const rawChatId = (message.chatId || chat?.id)?.toString?.() || null;
          const messageId = Number.isFinite(message.id) ? message.id : null;
          const groupLink = buildGroupLink(chat, rawChatId);
          const messageLink = buildMessageLink(chat, rawChatId, messageId);

          const chatId = normalizeMessageChatId(rawChatId);
          const groupId = extractGroupIdFromChatId(rawChatId);
          await enqueueAiMessage({
            accountId: accountId.toString(),
            chatId,
            messageId,
            text,
            senderName,
            senderUsername,
            senderId,
            groupId,
            groupLink,
            messageLink,
          });
          maybeSendReviewDumpCandidate({ chatId, messageId }).catch(() => {});
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
      await client.invoke(new Api.updates.GetState()).catch(() => {});
      await client.getDialogs({ limit: 20 }).catch(() => {});
      await setClientOnline(client);
      await markListenerConnected();
      //#region debug-point listener-missing-messages listener.connected
      await dbg('listener.connected', { accountId: accountId.toString(), groupsInDb: (account.groups || []).length });
      //#endregion debug-point listener-missing-messages listener.connected

      client.addEventHandler(
        async (event) => {
          try {
            const message = event?.message;
            const chatId = (message?.chatId || (await message?.getChat?.().catch(() => null))?.id)?.toString?.() || null;
            const messageId = Number.isFinite(message?.id) ? message.id : null;
            const text = (message?.text || message?.message || '').toString();
            const isGroup = !!event?.isGroup;
            const isChannel = !!event?.isChannel;
            const isPrivate = !!event?.isPrivate;
            const isOut = !!message?.out;

            let dropReason = null;
            if (!message) dropReason = 'no_message';
            else if (isOut) dropReason = 'out';
            else if (isPrivate) dropReason = 'private';
            else if (!(isGroup || isChannel)) dropReason = 'not_groupish';
            else if (!text.trim()) dropReason = 'no_text';

            lastListenerEventAt = Date.now();

            //#region debug-point listener-missing-messages listener.new_message
            await dbg('listener.new_message', {
              accountId: accountId.toString(),
              chatId,
              messageId,
              isGroup,
              isChannel,
              isPrivate,
              isOut,
              textChars: text.length,
              textPreview: truncateTraceText(text, 260),
              dropReason,
            });
            //#endregion debug-point listener-missing-messages listener.new_message

            if (dropReason) return;
            if (queue.length >= MAX_QUEUE) {
              const over = queue.length - MAX_QUEUE + 1;
              if (over > 0) queue.splice(0, over);
            }
            queue.push(message);
            markListenerSeen({ chatId: normalizeMessageChatId(chatId), messageId }).catch(() => {});
            processQueue().catch(() => {});
          } catch {}
        },
        new NewMessage({ incoming: true })
      );

      while (flag.running && !fatalAuthErr) {
        const idleMs = Date.now() - lastListenerEventAt;
        if (idleMs >= 120000) {
          //#region debug-point listener-missing-messages listener.idle
          await dbg('listener.idle', { accountId: accountId.toString(), idleMs, queue: queue.length });
          //#endregion debug-point listener-missing-messages listener.idle
        }
        try {
          await client.getMe();
          await client.invoke(new Api.updates.GetState()).catch(() => {});
          await setClientOnline(client);
          if (Date.now() - lastDialogsWarmAt >= DIALOGS_WARM_MS) {
            lastDialogsWarmAt = Date.now();
            await client.getDialogs({ limit: 120 }).catch(() => {});
          }
          if (idleMs >= RECONNECT_IDLE_MS) {
            try { await client.disconnect(); } catch {}
            await sleep(1500 + Math.random() * 1500);
            await client.connect();
            await client.getMe();
            await client.invoke(new Api.updates.GetState()).catch(() => {});
            await client.getDialogs({ limit: 120 }).catch(() => {});
            await setClientOnline(client);
            await markListenerConnected();
            lastListenerEventAt = Date.now();
            lastDialogsWarmAt = Date.now();
          }
        } catch (err) {
          if (isAuthError(err)) fatalAuthErr = err;
          else {
            await Account.updateOne({ _id: accountId }, { $set: { listenerLastError: err?.message?.toString?.() || 'listener_error' } }).catch(() => {});
            try { await client.disconnect(); } catch {}
            await sleep(2000 + Math.random() * 2000);
            try {
              await client.connect();
              await client.getMe();
              await client.invoke(new Api.updates.GetState()).catch(() => {});
              await client.getDialogs({ limit: 120 }).catch(() => {});
              await setClientOnline(client);
              await markListenerConnected();
            } catch {}
          }
        }
        await sleep(KEEPALIVE_MS);
      }

    } catch (err) {
      if (isAuthError(err)) fatalAuthErr = err;
      else await Account.updateOne({ _id: accountId }, { $set: { listenerLastError: err?.message?.toString?.() || 'listener_error' } }).catch(() => {});
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

async function releaseStaleGroupLinkClaims(maxAgeMs = 30 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  await GroupLink.updateMany(
    { status: 'claimed', claimedAt: { $ne: null, $lte: cutoff } },
    { $set: { status: 'new', claimedByAccountId: null, claimedRole: null, claimedAt: null } }
  ).catch(() => {});
}

async function getTakenGroupLinks(exceptAccountId) {
  const accounts = await Account.find(
    { role: { $in: ['listener', 'preacher'] }, _id: { $ne: exceptAccountId } },
    'groups.link groups.normalizedLink'
  );
  const links = new Set();
  for (const acc of accounts) {
    for (const g of acc.groups || []) {
      const key = g.normalizedLink || g.link || '';
      if (key) links.add(normalizeTmeLink(key));
    }
  }
  return links;
}

async function isGroupTakenByListenerOrPreacher(exceptAccountId, normalizedLink, resolvedEntityId = null) {
  const link = normalizedLink ? normalizeTmeLink(normalizedLink) : '';
  if (!link) return false;
  if (await isApprovedBotGroupChat(resolvedEntityId, null, link)) return false;
  const ors = [
    { 'groups.normalizedLink': link },
    { 'groups.link': link },
  ];
  const entId = resolvedEntityId?.toString?.() || '';
  if (entId) ors.push({ 'groups.id': entId });
  const exists = await Account.exists({
    role: { $in: ['listener', 'preacher'] },
    _id: { $ne: exceptAccountId },
    $or: ors,
  }).catch(() => null);
  return !!exists;
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
  //#region debug-point listener-missing-messages preacher.start
  await dbg('preacher.start', { accountId: accountId.toString(), groupsInDb: (seed?.groups || []).length });
  //#endregion debug-point listener-missing-messages preacher.start

  const joinWatch = new Map();

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

      const myUsername = me?.username ? me.username.toString().trim().replace(/^@/, '') : '';
      const myFirst = me?.firstName ? me.firstName.toString().trim() : '';
      const myLast = me?.lastName ? me.lastName.toString().trim() : '';
      const myId = me?.id?.toString?.() || '';
      const tokens = buildNameTokens({
        username: myUsername,
        firstName: myFirst,
        lastName: myLast,
        fallbackUsername: account?.username || '',
      });
      const acctNum = (account?.number ?? '').toString().trim();
      if (acctNum) {
        tokens.push(`preacher_${acctNum}`);
        tokens.push(`preacher ${acctNum}`);
      }
      const mentionRegexes = compileMentionRegexes([...new Set(tokens)]);
      const handler = async (event) => {
        try {
          if (!joinWatch.size) return;
          const message = event?.message;
          if (!message || message.out) return;
          const chat = await message.getChat().catch(() => null);
          const rawChatId = (message.chatId || chat?.id)?.toString?.() || null;
          const internal = canonicalInternalChatId(rawChatId);
          if (!internal) return;
          const rec = joinWatch.get(internal);
          if (!rec) return;
          if (Date.now() > rec.expiresAt) { joinWatch.delete(internal); return; }
          if (rec.notified) return;

          const entities = message?.entities || [];
          const mentionedByEntity = !!(myId && entities.some((e) => {
            const uid = e?.userId ?? e?.user_id;
            if (!uid) return false;
            return uid.toString?.() === myId;
          }));

          const text = (message.text || message.message || '').toString();
          const mentionedByText = !!(text && mentionRegexes.some((rx) => rx.test(text)));
          if (!mentionedByEntity && !mentionedByText) return;

          rec.notified = true;
          joinWatch.delete(internal);

          const uname = chat?.username ? chat.username.toString().trim().replace(/^@/, '') : '';
          const groupLink = uname ? `https://t.me/${uname}` : rec.groupLink || null;
          const messageId = Number.isFinite(message?.id) ? message.id : null;
          const messageLink = messageId
            ? (uname ? `https://t.me/${uname}/${messageId}` : rawChatId.startsWith('-100') ? `https://t.me/c/${rawChatId.slice(4)}/${messageId}` : null)
            : null;

          const header =
            `🚨 Join verification message detected\n\n` +
            `accountId: ${accountId.toString()}\n` +
            `preacher: ${myUsername ? `@${myUsername}` : (account.username ? `@${account.username}` : account.number)}\n` +
            `group: ${rec.groupTitle || chat?.title || internal}\n` +
            `groupLink: ${groupLink || 'n/a'}\n` +
            `messageLink: ${messageLink || 'n/a'}\n\n`;
          await notifyAllAdmins(`${header}${text}`);
        } catch {}
      };

      client.addEventHandler(handler, new NewMessage({}));

      while (flag.running) {
        const rotation = await getTemplateRotation(accountId);
        const groupsSnapshot = [...getGroups(accountId)];
        const canPreach = !!(rotation?.items?.length && groupsSnapshot.length);
        //#region debug-point listener-missing-messages preacher.state
        await dbg('preacher.state', {
          accountId: accountId.toString(),
          canPreach,
          templates: rotation?.items?.length || 0,
          groups: groupsSnapshot.length,
        });
        //#endregion debug-point listener-missing-messages preacher.state
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
            if (await isApprovedBotGroupChat(entity.id, group.id, group.link)) continue;

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
        await releaseStaleGroupLinkClaims();
        const takenLinks = await getTakenGroupLinks(accountId);

        while (flag.running) {
          const acc = await Account.findById(accountId, 'groups');
          if (!acc) { flag.running = false; break; }
          if ((acc.groups?.length || 0) >= 500) break;
          if (joinedThisPhase >= joinBatch) break;

          const linkDoc = await claimNextPreacherLink(accountId);
          if (!linkDoc) break;

          const link = normalizeTmeLink(linkDoc.normalizedLink || linkDoc.link);
          if (takenLinks.has(link)) {
            await markGroupLink(linkDoc, { status: 'dead', lastError: 'taken' });
            await sleep(2000 + Math.random() * 3000);
            continue;
          }

          let resolvedEntityId = null;
          try {
            const uname = extractUsernameFromLink(link);
            if (uname) {
              const ent = await client.getEntity(uname);
              resolvedEntityId = ent?.id || null;
            }
          } catch {}

          const takenNow = await isGroupTakenByListenerOrPreacher(accountId, link, resolvedEntityId);
          if (takenNow) {
            await markGroupLink(linkDoc, { status: 'dead', lastError: 'taken' });
            takenLinks.add(link);
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
            normalizedLink: link,
          } : { id: link, name: link, link, normalizedLink: link };

          await Account.updateOne({ _id: accountId }, { $addToSet: { groups: groupInfo } });
          addGroup(accountId, groupInfo);
          await markGroupLink(linkDoc, { status: 'joined', joinedByAccountId: accountId.toString(), joinedRole: 'preacher', joinedAt: new Date() });
          joinedThisPhase++;
          takenLinks.add(link);

          if (resolvedEntity?.id) {
            const internal = canonicalInternalChatId(resolvedEntity.id?.toString?.() || resolvedEntity.id);
            if (!internal) {
              await sleep(15000 + Math.random() * 20000);
              continue;
            }
            joinWatch.set(internal, {
              expiresAt: Date.now() + Math.max(60_000, Number(process.env.PREACHER_JOIN_WATCH_MS || 3 * 60 * 1000)),
              groupLink: link,
              groupTitle: resolvedEntity?.title || link,
              notified: false,
            });
          }

          await sleep(15000 + Math.random() * 20000);
        }

        await prunePreacherOverlaps(client, accountId);
        await sleep(60000);
      }

      try { client.removeEventHandler(handler); } catch {}
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
