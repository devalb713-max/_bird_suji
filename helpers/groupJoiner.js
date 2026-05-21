import { Api } from 'telegram/tl/index.js';
import { Account, Keyword, BotChat, GroupLink, ApprovedChat, BotSettings } from '../models/db.js';
import { createClient, sendWithTyping, extractUsernameFromLink, extractInviteHash, sleep, isFloodError, getFloodSeconds, isAuthError } from './telegram.js';
import { addGroup } from './groupRegistry.js';

const SEARCH_BOT = process.env.SEARCH_BOT_USERNAME || 'en_SearchBot';
const DAILY_LIMIT_PATTERN = /(you have reached your daily usage limit|daily usage limit exceeded|bot unresponsive|unlock or try (again )?tomorrow)/i;
const NO_RESULTS_PATTERN = /sorry,?\s*no link found/i;

function isSearchLimitMessage(text = '') {
  return DAILY_LIMIT_PATTERN.test(text) || text.includes('t.me/OKSearch?start=');
}

function isNoResultsMessage(text = '') {
  return NO_RESULTS_PATTERN.test(text);
}

function pickLatestBotTextMessage(msgs = []) {
  const m = (msgs || []).find(x => x && !x.out && !x.action && typeof x.message === 'string' && x.message.trim());
  return m?.message || '';
}

function classifySearchBotResponse(msgs = []) {
  const txt = pickLatestBotTextMessage(msgs);
  if (txt && isSearchLimitMessage(txt)) return { kind: 'limit', text: txt };
  if (txt && isNoResultsMessage(txt)) return { kind: 'no_results', text: txt };
  const reply = (msgs || []).find(isValidBotResultMessage) || null;
  if (reply) return { kind: 'result', reply };
  return { kind: 'unknown', text: txt || '' };
}

// Collect all group links currently joined by any account (uniqueness enforcement)
async function getAllJoinedGroupLinks() {
  const accounts = await Account.find({}, 'groups.link');
  const links = new Set();
  for (const acc of accounts) {
    for (const g of acc.groups) {
      if (g.link) links.add(g.link.toLowerCase().trim());
    }
  }
  return links;
}

let _approvedGroupsCache = { loadedAt: 0, ids: new Set(), links: new Set() };

function isApprovedIdMatch(resolvedEntityId, approvedIdSet) {
  const id = resolvedEntityId?.toString?.() || '';
  if (!id) return false;
  if (approvedIdSet.has(id)) return true;
  if (approvedIdSet.has(`-${id}`)) return true;
  if (approvedIdSet.has(`-100${id}`)) return true;
  return false;
}

async function getApprovedGroupExemptions() {
  const stale = !_approvedGroupsCache.loadedAt || (Date.now() - _approvedGroupsCache.loadedAt) > 60 * 1000;
  if (!stale) return _approvedGroupsCache;

  const [settings, rows] = await Promise.all([
    BotSettings.findOne({}, { requiredGroupId: 1, requiredGroupInviteLink: 1 }).lean().catch(() => null),
    ApprovedChat.find({ type: 'group' }, { chatId: 1, inviteLink: 1 }).lean().catch(() => []),
  ]);

  const ids = new Set();
  const links = new Set();

  const requiredId = settings?.requiredGroupId ? settings.requiredGroupId.toString() : '';
  if (requiredId) ids.add(requiredId);
  const requiredLink = settings?.requiredGroupInviteLink ? normalizeTmeLink(settings.requiredGroupInviteLink) : '';
  if (requiredLink) links.add(requiredLink);

  for (const r of rows || []) {
    const cid = r?.chatId ? r.chatId.toString() : '';
    if (cid) ids.add(cid);
    const l = r?.inviteLink ? normalizeTmeLink(r.inviteLink) : '';
    if (l) links.add(l);
  }

  _approvedGroupsCache = { loadedAt: Date.now(), ids, links };
  return _approvedGroupsCache;
}

async function isApprovedBotGroup({ normalizedLink, resolvedEntityId }) {
  const link = normalizedLink ? normalizeTmeLink(normalizedLink) : '';
  if (!link) return false;
  const { ids, links } = await getApprovedGroupExemptions();
  if (links.has(link)) return true;
  if (resolvedEntityId && isApprovedIdMatch(resolvedEntityId, ids)) return true;
  return false;
}

async function isGroupTakenByListenerOrPreacher(exceptAccountId, normalizedLink, resolvedEntityId = null) {
  const link = normalizedLink ? normalizeTmeLink(normalizedLink) : '';
  if (!link) return false;
  if (await isApprovedBotGroup({ normalizedLink: link, resolvedEntityId })) return false;
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

function listenerGroupKey(g) {
  const id = g?.id?.toString?.() || '';
  if (/^\d+$/.test(id)) return `id:${id}`;
  const link = g?.link ? normalizeTmeLink(g.link) : '';
  if (link) return `link:${link}`;
  return null;
}

function workerGroupKey(g) {
  const link = g?.normalizedLink ? normalizeTmeLink(g.normalizedLink) : g?.link ? normalizeTmeLink(g.link) : '';
  if (link) return `link:${link}`;
  const id = g?.id?.toString?.() || '';
  if (id) return `id:${id}`;
  return null;
}

async function resolveEntityForGroup(client, group) {
  if (!group) return null;
  const id = group?.id?.toString?.() || '';
  if (id) {
    const digits = id.replace(/^-100/, '').replace(/^-/, '');
    if (/^\d+$/.test(digits)) {
      const variants = [digits, `-100${digits}`, `-${digits}`];
      for (const v of variants) {
        try {
          const ent = await client.getEntity(v);
          if (ent) return ent;
        } catch {}
        try {
          const ent = await client.getEntity(BigInt(v));
          if (ent) return ent;
        } catch {}
      }
    }
  }

  const uname = extractUsernameFromLink(group?.normalizedLink || group?.link || '');
  if (uname) {
    const ent = await client.getEntity(uname).catch(() => null);
    if (ent) return ent;
  }
  return null;
}

async function leaveEntity(client, entity) {
  if (!entity) return false;
  if (entity.className === 'Chat') {
    await client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf() }));
    return true;
  }
  await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
  return true;
}

async function leaveWorkerGroup(client, accountId, group) {
  const entity = await resolveEntityForGroup(client, group);
  if (!entity) return false;
  try {
    await leaveEntity(client, entity);
  } catch {
    return false;
  }

  const ors = [];
  if (group?.id) ors.push({ id: group.id.toString() });
  if (group?.normalizedLink) ors.push({ normalizedLink: normalizeTmeLink(group.normalizedLink) });
  if (group?.link) ors.push({ link: group.link.toString() });
  if (!ors.length) return true;

  await Account.updateOne(
    { _id: accountId },
    { $pull: { groups: { $or: ors } } }
  ).catch(() => {});
  return true;
}

async function leaveListenerGroup(client, accountId, group) {
  let entity = null;
  const id = group?.id?.toString?.() || '';
  if (/^\d+$/.test(id)) {
    entity = await client.getEntity(id).catch(() => null);
    if (!entity) {
      try { entity = await client.getEntity(BigInt(id)).catch(() => null); } catch {}
    }
  }
  if (!entity) {
    const uname = extractUsernameFromLink(group?.link || '');
    if (uname) entity = await client.getEntity(uname).catch(() => null);
  }
  if (!entity) return false;
  const left = await client.invoke(new Api.channels.LeaveChannel({ channel: entity })).then(() => true).catch(() => false);
  if (!left) return false;
  const pull = /^\d+$/.test(id) ? { id } : group?.link ? { link: group.link } : null;
  if (pull) await Account.updateOne({ _id: accountId }, { $pull: { groups: pull } }).catch(() => {});
  return true;
}

function fingerprintBotResultMessage(m) {
  if (!m) return '';
  const text = (m.message || '').toString();
  const ents = Array.isArray(m.entities)
    ? m.entities.map(e => `${e.className || ''}:${e.offset || 0}:${e.length || 0}:${e.url || ''}`).join('|')
    : '';
  const rows = m.replyMarkup?.rows?.map(r => (r.buttons || []).map(b => `${b.text || ''}:${b.data ? b.data.toString('utf8') : ''}`).join(',')).join('|') || '';
  return `${m.id || ''}::${text}::${ents}::${rows}`;
}

async function clickButtonAndWait(client, botEntity, msgId, btn, waitMs = 4000, previousFingerprint = null) {
  const backoffs = [waitMs, waitMs + 4000, waitMs + 12000, waitMs + 25000];

  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    try {
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer: botEntity,
        msgId,
        data: btn.data,
      }));
    } catch (e) {
      if (isFloodError(e)) {
        const secs = getFloodSeconds(e);
        await sleep(secs * 1000);
        continue;
      }
      if (!e.message?.includes('BOT_RESPONSE_TIMEOUT')) throw e;
    }

    await sleep(backoffs[attempt]);
    try {
      const byId = await client.getMessages(botEntity, { ids: [msgId] }).catch(() => null);
      const updated = Array.isArray(byId) ? byId[0] : byId;
      if (updated && isValidBotResultMessage(updated)) {
        const fp = fingerprintBotResultMessage(updated);
        if (!previousFingerprint || fp !== previousFingerprint) return updated;
      }
    } catch {}

    const msgs = await client.getMessages(SEARCH_BOT, { limit: 10 }).catch(() => []);
    const next = msgs.find(isValidBotResultMessage) || null;
    if (!next) continue;

    const fp = fingerprintBotResultMessage(next);
    if (previousFingerprint && fp === previousFingerprint) continue;
    return next;
  }

  return null;
}

// A real search-result message always has at least one callback button whose data
// starts with "filter|". Broadcast ads use "top_keyword|" data; welcome messages
// use plain KeyboardButtons with no data field; limit messages have no markup at all.
function isValidBotResultMessage(msg) {
  if (!msg || msg.out || msg.action) return false;
  const rows = msg.replyMarkup?.rows;
  if (!rows?.length) return false;
  return rows.flatMap(r => r.buttons).some(
    btn => btn.data?.toString('utf8').startsWith('filter|')
  );
}

// Extract t.me group links from the bot's reply message entities
function extractGroupLinks(msg) {
  const links = [];
  if (!msg?.message || !msg?.entities?.length) return links;
  const text = msg.message;
  for (const ent of msg.entities) {
    // MessageEntityTextUrl carries the URL in ent.url; MessageEntityUrl is a raw URL in the text
    const url = ent.url || (ent.className === 'MessageEntityUrl' ? text.slice(ent.offset, ent.offset + ent.length) : null);
    if (url && url.includes('t.me/')) {
      links.push(url);
    }
  }
  return links;
}

// Join a group by its t.me link; returns { joined: bool, entity: object|null }
// retried: internal flag to prevent infinite recursion on repeated flood
async function joinGroupLink(client, link, retried = false) {
  try {
    const hash = extractInviteHash(link);
    if (hash) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      // Private invite — resolve entity after joining
      try {
        const username = extractUsernameFromLink(link);
        if (username) {
          const entity = await client.getEntity(username);
          return { joined: true, entity };
        }
      } catch {}
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
      try {
        const username = extractUsernameFromLink(link);
        const entity = username ? await client.getEntity(username) : null;
        return { joined: true, entity };
      } catch {
        return { joined: true, entity: null };
      }
    }
    if (msg.includes('CHANNELS_TOO_MUCH')) throw err;
    if (isFloodError(err)) {
      const secs = getFloodSeconds(err);
      // Long floods (>5 min) mean the account is heavily rate-limited — propagate so the session pauses
      if (retried || secs > 300) throw err;
      console.log(`  flood ${secs}s for ${link.split('/').pop()} — retrying after wait`);
      await sleep(secs * 1000);
      return joinGroupLink(client, link, true);
    }
    console.log(`  skip ${link.split('/').pop()}: ${msg || 'unknown error'}`);
    return { joined: false, entity: null };
  }
}

async function claimNextKeyword(accountId) {
  const now = new Date();
  const lockUntil = new Date(Date.now() + 10 * 60 * 1000);
  const id = accountId.toString();
  return Keyword.findOneAndUpdate(
    {
      assignedToAccountId: id,
      $or: [
        { lockExpiresAt: null },
        { lockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        lockedByAccountId: id,
        lockedAt: now,
        lockExpiresAt: lockUntil,
      },
    },
    { sort: { lastProcessedAt: 1, assignedOrder: 1, createdAt: 1 }, new: true }
  );
}

async function releaseKeyword(keywordDoc, accountId) {
  if (!keywordDoc?._id) return;
  const now = new Date();
  await Keyword.updateOne(
    { _id: keywordDoc._id, lockedByAccountId: accountId.toString() },
    {
      $set: {
        lockedByAccountId: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastProcessedAt: now,
        lastProcessedByAccountId: accountId.toString(),
      },
    }
  ).catch(() => {});
}

let lastKeywordRebalanceAt = 0;

async function rebalanceKeywordPools() {
  const finderAccounts = await Account.find(
    { role: 'finder', session: { $nin: [null, ''] } },
    '_id createdAt'
  )
    .sort({ createdAt: 1 })
    .lean();

  const accountIds = finderAccounts.map((a) => a._id.toString());
  if (!accountIds.length) return;

  const keywords = await Keyword.find({}, '_id createdAt assignedToAccountId assignedOrder')
    .sort({ createdAt: 1 })
    .lean();

  if (!keywords.length) return;

  const ops = [];
  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i];
    const target = accountIds[i % accountIds.length];
    if (k.assignedToAccountId !== target || k.assignedOrder !== i) {
      ops.push({
        updateOne: {
          filter: { _id: k._id },
          update: { $set: { assignedToAccountId: target, assignedOrder: i } },
        },
      });
    }
  }

  if (ops.length) {
    await Keyword.bulkWrite(ops, { ordered: false });
  }
}

async function maybeRebalanceKeywordPools(force = false) {
  const now = Date.now();
  if (!force && now - lastKeywordRebalanceAt < 5 * 60 * 1000) return;
  lastKeywordRebalanceAt = now;
  await rebalanceKeywordPools().catch(() => {});
}

function normalizeTmeLink(link) {
  try {
    const u = new URL(link);
    return `https://t.me/${u.pathname.replace(/^\//, '').toLowerCase()}`;
  } catch {
    return link.toLowerCase().trim();
  }
}

async function storeDiscoveredLinks(rawLinks, keyword, accountId) {
  const links = [...new Set((rawLinks || []).map(normalizeTmeLink).filter(Boolean))];
  const seen = links.length;
  if (!seen) return { seen: 0, saved: 0 };

  const docs = links.map((l) => ({
    link: l,
    normalizedLink: l,
    sourceKeyword: keyword || null,
    foundByAccountId: accountId?.toString?.() || null,
    foundAt: new Date(),
    status: 'new',
  }));

  try {
    const res = await GroupLink.insertMany(docs, { ordered: false });
    return { seen, saved: res?.length || 0 };
  } catch (err) {
    const saved =
      err?.insertedDocs?.length ||
      err?.result?.result?.nInserted ||
      err?.result?.nInserted ||
      err?.insertedCount ||
      0;
    return { seen, saved };
  }
}

async function claimNextGroupLink(role, accountId) {
  const now = new Date();
  return GroupLink.findOneAndUpdate(
    { status: 'new' },
    {
      $set: { status: 'claimed', claimedByAccountId: accountId.toString(), claimedRole: role, claimedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, new: true }
  );
}

async function markLink(linkDoc, patch) {
  if (!linkDoc?._id) return;
  await GroupLink.updateOne({ _id: linkDoc._id }, { $set: patch }).catch(() => {});
}

async function runGroupFinder(accountId, flag) {
  while (flag.running) {
    const account = await Account.findById(accountId);
    if (!account) { flag.running = false; return; }
    if (!account.session) { flag.running = false; return; }

    const label = account.username || account.number;
    const client = createClient(account.session, accountId);
    let keywordDoc = null;

    try {
      await client.connect();
      const refreshed = client.session.save();
      if (refreshed && refreshed !== account.session) {
        await Account.updateOne({ _id: accountId }, { session: refreshed });
      }
      const botEntity = await client.getEntity(SEARCH_BOT);

      await maybeRebalanceKeywordPools();

      if (!account.searchBotStartedAt) {
        const existingThread = await client.getMessages(SEARCH_BOT, { limit: 1 }).catch(() => []);
        if (existingThread?.length) {
          await Account.updateOne({ _id: accountId }, { $set: { searchBotStartedAt: new Date() } }).catch(() => {});
        } else {
          await client.sendMessage(botEntity, { message: '/start' });
          await Account.updateOne({ _id: accountId }, { $set: { searchBotStartedAt: new Date() } }).catch(() => {});
          await sleep(2000 + Math.random() * 2000);
        }
      }

      keywordDoc = await claimNextKeyword(accountId);
      if (!keywordDoc) {
        await maybeRebalanceKeywordPools(true);
        keywordDoc = await claimNextKeyword(accountId);
      }
      const keyword = keywordDoc?.word || null;
      if (!keyword) {
        await client.disconnect();
        await sleep(300000);
        continue;
      }

      await sendWithTyping(client, botEntity, keyword);
      await sleep(4000 + Math.random() * 3000);

      const msgs = await client.getMessages(SEARCH_BOT, { limit: 10 });
      const initial = classifySearchBotResponse(msgs);
      if (initial.kind === 'limit') {
        const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await Account.updateOne(
          { _id: accountId },
          { searchLimitHit: true, searchLimitResetsAt: resetsAt, isJoining: true }
        );
        flag.running = false;
        await releaseKeyword(keywordDoc, accountId);
        await client.disconnect();
        return;
      }
      if (initial.kind === 'no_results') {
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(2000 + Math.random() * 2000);
        continue;
      }
      let reply = initial.kind === 'result' ? initial.reply : null;
      if (!reply) {
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(8000 + Math.random() * 4000);
        continue;
      }

      const allBtns = reply.replyMarkup?.rows?.flatMap(r => r.buttons) || [];
      const groupsBtn = allBtns.find(b => (b.text || '').includes('👥'));
      if (!groupsBtn) {
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(10000);
        continue;
      }
      reply = await clickButtonAndWait(client, botEntity, reply.id, groupsBtn, 5000 + Math.random() * 3000, fingerprintBotResultMessage(reply));
      if (!reply) {
        const after = await client.getMessages(SEARCH_BOT, { limit: 10 }).catch(() => []);
        const sig = classifySearchBotResponse(after);
        if (sig.kind === 'limit') {
          const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await Account.updateOne(
            { _id: accountId },
            { searchLimitHit: true, searchLimitResetsAt: resetsAt, isJoining: true }
          );
          flag.running = false;
          await releaseKeyword(keywordDoc, accountId);
          await client.disconnect();
          return;
        }
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(10000);
        continue;
      }

      let pageNum = 1;
      while (flag.running) {
        const groupLinks = extractGroupLinks(reply);
        const { seen, saved } = await storeDiscoveredLinks(groupLinks, keyword, accountId);
        console.log(`[Finder:${label}] Page ${pageNum} "${keyword}" saved ${saved}/${seen}`);

        const pageBtns = reply.replyMarkup?.rows?.flatMap(r => r.buttons) || [];
        const nextBtn = pageBtns.find(b => (b.text || '').includes('➡️') || /next/i.test((b.text || '').toString()));
        if (!nextBtn) break;
        reply = await clickButtonAndWait(client, botEntity, reply.id, nextBtn, 8000 + Math.random() * 7000, fingerprintBotResultMessage(reply));
        if (!reply) {
          const after = await client.getMessages(SEARCH_BOT, { limit: 10 }).catch(() => []);
          const sig = classifySearchBotResponse(after);
          if (sig.kind === 'limit') {
            const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await Account.updateOne(
              { _id: accountId },
              { searchLimitHit: true, searchLimitResetsAt: resetsAt, isJoining: true }
            );
            flag.running = false;
            await releaseKeyword(keywordDoc, accountId);
            await client.disconnect();
            return;
          }
          break;
        }
        pageNum++;
        await sleep(3000 + Math.random() * 4000);
      }

      await client.disconnect();
      await releaseKeyword(keywordDoc, accountId);

    } catch (err) {
      try { await client.disconnect(); } catch {}
      await releaseKeyword(keywordDoc, accountId);
      if (isAuthError(err)) {
        await Account.updateOne({ _id: accountId }, { isJoining: false, isMessaging: false, session: null });
        flag.running = false;
        return;
      }
      if (isFloodError(err)) {
        const secs = getFloodSeconds(err);
        await sleep(secs * 1000);
      } else {
        await sleep(30000);
      }
    }

    if (flag.running) await sleep(20000 + Math.random() * 30000);
  }

  await Account.updateOne({ _id: accountId }, { isJoining: false });
}

async function runJoinFromDb(accountId, flag) {
  while (flag.running) {
    const account = await Account.findById(accountId);
    if (!account) { flag.running = false; return; }
    if (!account.session) { flag.running = false; return; }

    const role = account.role === 'preacher' ? 'preacher' : 'listener';
    const label = account.username || account.number;

    if ((account.groups?.length || 0) >= 500) {
      await Account.updateOne({ _id: accountId }, { isJoining: false });
      flag.running = false;
      return;
    }

    const linkDoc = await claimNextGroupLink(role, accountId);
    if (!linkDoc) {
      await sleep(60000);
      continue;
    }

    const link = linkDoc.normalizedLink;
    const client = createClient(account.session, accountId);
    try {
      await client.connect();
      if (!flag.running) { try { await client.disconnect(); } catch {} break; }
      const refreshed = client.session.save();
      if (refreshed && refreshed !== account.session) {
        await Account.updateOne({ _id: accountId }, { session: refreshed });
      }

      let resolvedEntityForCheck = null;
      try {
        const hash = extractInviteHash(link);
        if (!hash) {
          const uname = extractUsernameFromLink(link);
          if (uname) resolvedEntityForCheck = await client.getEntity(uname);
        }
      } catch {}

      const taken = await isGroupTakenByListenerOrPreacher(accountId, link, resolvedEntityForCheck?.id);
      if (taken) {
        await markLink(linkDoc, { status: 'dead', lastError: 'taken' });
        await client.disconnect();
        await sleep(2000 + Math.random() * 2000);
        continue;
      }

      const { joined, entity: joinedEntity } = await joinGroupLink(client, link);
      if (!flag.running) {
        try {
          if (joinedEntity) await client.invoke(new Api.channels.LeaveChannel({ channel: joinedEntity })).catch(() => {});
        } catch {}
        try { await client.disconnect(); } catch {}
        break;
      }
      if (!joined) {
        const nextStatus = (linkDoc.attempts || 0) >= 3 ? 'dead' : 'new';
        await markLink(linkDoc, { status: nextStatus, lastError: 'join_failed' });
        await client.disconnect();
        await sleep(5000 + Math.random() * 5000);
        continue;
      }

      let groupInfo = { link, name: link, id: link, normalizedLink: link };
      let resolvedEntity = joinedEntity;
      if (!resolvedEntity) {
        try {
          const uname = extractUsernameFromLink(link);
          if (uname) resolvedEntity = await client.getEntity(uname);
        } catch {}
      }
      if (resolvedEntity) {
        groupInfo = {
          id: resolvedEntity.id?.toString() || link,
          name: resolvedEntity.title || link,
          link,
          normalizedLink: link,
        };
      }

      if (role === 'preacher' && resolvedEntity?.defaultBannedRights?.sendMessages) {
        try { await client.invoke(new Api.channels.LeaveChannel({ channel: resolvedEntity })); } catch {}
        await markLink(linkDoc, { status: 'dead', lastError: 'cannot_send_messages' });
        await client.disconnect();
        await sleep(5000 + Math.random() * 5000);
        continue;
      }

      if (!flag.running) { try { await client.disconnect(); } catch {} break; }
      await Account.updateOne({ _id: accountId }, { $addToSet: { groups: groupInfo } });
      addGroup(accountId, groupInfo);
      await markLink(linkDoc, { status: 'joined', joinedByAccountId: accountId.toString(), joinedRole: role, joinedAt: new Date() });

      if (resolvedEntity) {
        try {
          await sleep(1500 + Math.random() * 1000);
          const recent = await client.getMessages(resolvedEntity, { limit: 20 });
          const serviceIds = recent.filter(m => m.action).map(m => m.id);
          if (serviceIds.length) {
            await client.deleteMessages(resolvedEntity, serviceIds, { revoke: true }).catch(() => {});
          }
        } catch {}
      }

      await client.disconnect();
      console.log(`[Joiner:${label}] Joined ${groupInfo.link} (${(account.groups?.length || 0) + 1})`);
      await sleep(15000 + Math.random() * 20000);

    } catch (err) {
      try { await client.disconnect(); } catch {}
      if (err?.message?.includes('CHANNELS_TOO_MUCH')) {
        await Account.updateOne({ _id: accountId }, { isJoining: false });
        flag.running = false;
        return;
      }
      if (isAuthError(err)) {
        await Account.updateOne({ _id: accountId }, { isJoining: false, isMessaging: false });
        flag.running = false;
        return;
      }
      if (isFloodError(err)) {
        const secs = getFloodSeconds(err);
        await markLink(linkDoc, { status: 'new', lastError: `flood_${secs}s` });
        await sleep(secs * 1000);
      } else {
        await markLink(linkDoc, { status: 'new', lastError: err?.message || 'error' });
        await sleep(30000);
      }
    }
  }

  await Account.updateOne({ _id: accountId }, { isJoining: false });
}

let membershipSyncRunning = false;

function isGroupishEntity(ent) {
  if (!ent) return false;
  if (ent.className === 'Chat') return true;
  if (ent.className === 'Channel' && ent.megagroup) return true;
  return false;
}

function buildGroupSnapshotFromDialogs(dialogs, existingGroups) {
  const existingById = new Map();
  for (const g of existingGroups || []) {
    const id = g?.id?.toString?.() || '';
    if (id) existingById.set(id, g);
  }

  const out = [];
  const seen = new Set();
  for (const d of dialogs || []) {
    const ent = d?.entity || null;
    if (!isGroupishEntity(ent)) continue;
    const id = ent?.id?.toString?.() || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = ent?.title?.toString?.() || id;
    const uname = ent?.username?.toString?.().replace(/^@/, '').trim() || '';
    const freshLink = uname ? `https://t.me/${uname}` : null;

    const prev = existingById.get(id) || null;
    const link = freshLink || (prev?.link ? prev.link.toString() : null);
    const normalizedLink = link ? normalizeTmeLink(link) : null;

    out.push({ id, name, link, normalizedLink });
  }
  return out;
}

export async function syncListenerAndPreacherGroupsOnce() {
  if (membershipSyncRunning) return;
  membershipSyncRunning = true;
  try {
    const accounts = await Account.find(
      { role: { $in: ['listener', 'preacher'] }, session: { $nin: [null, ''] } },
      { _id: 1, session: 1, groups: 1, username: 1, number: 1 }
    ).lean();

    for (const acc of accounts || []) {
      const label = acc.username || acc.number || acc._id?.toString?.() || 'account';
      const client = createClient(acc.session, acc._id);
      try {
        await client.connect();
        const refreshed = client.session.save();
        if (refreshed && refreshed !== acc.session) {
          await Account.updateOne({ _id: acc._id }, { session: refreshed }).catch(() => {});
        }

        const dialogs = await client.getDialogs({ limit: 600 }).catch(() => []);
        const groups = buildGroupSnapshotFromDialogs(dialogs, acc.groups);
        await Account.updateOne(
          { _id: acc._id },
          { $set: { groups, groupsSyncedAt: new Date(), groupsSyncError: null } }
        ).catch(() => {});
      } catch (err) {
        if (isAuthError(err)) {
          await Account.updateOne(
            { _id: acc._id },
            { $set: { groupsSyncedAt: new Date(), groupsSyncError: 'auth_error' } }
          ).catch(() => {});
        } else if (isFloodError(err)) {
          const secs = getFloodSeconds(err);
          await Account.updateOne(
            { _id: acc._id },
            { $set: { groupsSyncedAt: new Date(), groupsSyncError: `flood_${secs}s` } }
          ).catch(() => {});
          await sleep(secs * 1000);
        } else {
          await Account.updateOne(
            { _id: acc._id },
            { $set: { groupsSyncedAt: new Date(), groupsSyncError: (err?.message || 'error').toString().slice(0, 180) } }
          ).catch(() => {});
        }
        console.log(`[GroupsSync] ${label} sync error: ${err?.message || 'error'}`);
      } finally {
        try { await client.disconnect(); } catch {}
      }

      await sleep(1500 + Math.random() * 1500);
    }
  } finally {
    membershipSyncRunning = false;
  }
}

export async function enforceUniqueListenerGroupsOnce() {
  const maxLeaves = Math.max(1, Math.min(30, Number(process.env.LISTENER_DEDUPE_MAX_LEAVES || 8)));
  const accounts = await Account.find(
    { role: 'listener', session: { $nin: [null, ''] } },
    { _id: 1, createdAt: 1, session: 1, groups: 1, username: 1, number: 1 }
  ).lean();

  const byKey = new Map();
  for (const acc of accounts) {
    for (const g of acc.groups || []) {
      const key = listenerGroupKey(g);
      if (!key) continue;
      const list = byKey.get(key) || [];
      list.push({ acc, g, key });
      byKey.set(key, list);
    }
  }

  const leaves = [];
  for (const [key, list] of byKey.entries()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => {
      const ta = a.acc.createdAt ? new Date(a.acc.createdAt).getTime() : 0;
      const tb = b.acc.createdAt ? new Date(b.acc.createdAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.acc._id.toString().localeCompare(b.acc._id.toString());
    });
    const winner = list[0];
    for (let i = 1; i < list.length; i++) {
      leaves.push({ winnerId: winner.acc._id.toString(), loser: list[i] });
    }
  }

  let did = 0;
  const seenLosers = new Set();
  for (const item of leaves) {
    if (did >= maxLeaves) break;
    const loserAcc = item.loser.acc;
    const loserId = loserAcc._id.toString();
    const group = item.loser.g;
    const groupKey = item.loser.key;
    const perAccountKey = `${loserId}::${groupKey}`;
    if (seenLosers.has(perAccountKey)) continue;
    seenLosers.add(perAccountKey);

    const client = createClient(loserAcc.session, loserAcc._id);
    try {
      await client.connect();
      const left = await leaveListenerGroup(client, loserAcc._id, group);
      if (left) {
        did++;
        await sleep(2500 + Math.random() * 2500);
      }
    } catch {
      try { await client.disconnect(); } catch {}
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }
}

export async function enforceUniqueWorkerGroupsOnce() {
  const maxLeaves = Math.max(1, Math.min(60, Number(process.env.WORKER_GROUP_DEDUPE_MAX_LEAVES || 20)));
  const { ids: approvedIds, links: approvedLinks } = await getApprovedGroupExemptions();
  const accounts = await Account.find(
    { role: { $in: ['listener', 'preacher'] }, session: { $nin: [null, ''] } },
    { _id: 1, role: 1, createdAt: 1, session: 1, groups: 1, username: 1, number: 1 }
  ).lean();

  const byKey = new Map();
  for (const acc of accounts) {
    for (const g of acc.groups || []) {
      const key = workerGroupKey(g);
      if (!key) continue;
      if (key.startsWith('link:')) {
        const link = key.slice(5);
        if (approvedLinks.has(link)) continue;
      } else if (key.startsWith('id:')) {
        const id = key.slice(3);
        if (isApprovedIdMatch(id, approvedIds)) continue;
      }
      const list = byKey.get(key) || [];
      list.push({ acc, g, key });
      byKey.set(key, list);
    }
  }

  const leaves = [];
  for (const [key, list] of byKey.entries()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => {
      const ra = (a.acc.role || '').toString();
      const rb = (b.acc.role || '').toString();
      if (ra !== rb) {
        if (ra === 'listener') return -1;
        if (rb === 'listener') return 1;
      }
      const ta = a.acc.createdAt ? new Date(a.acc.createdAt).getTime() : 0;
      const tb = b.acc.createdAt ? new Date(b.acc.createdAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.acc._id.toString().localeCompare(b.acc._id.toString());
    });
    const winner = list[0];
    for (let i = 1; i < list.length; i++) {
      leaves.push({ winner, loser: list[i] });
    }
  }

  let did = 0;
  const seenLosers = new Set();
  for (const item of leaves) {
    if (did >= maxLeaves) break;
    const loserAcc = item.loser.acc;
    const loserId = loserAcc._id.toString();
    const group = item.loser.g;
    const groupKey = item.loser.key;
    const perAccountKey = `${loserId}::${groupKey}`;
    if (seenLosers.has(perAccountKey)) continue;
    seenLosers.add(perAccountKey);

    const label = loserAcc.username || loserAcc.number || loserId;
    const client = createClient(loserAcc.session, loserAcc._id);
    try {
      await client.connect();
      const left = await leaveWorkerGroup(client, loserAcc._id, group);
      if (left) {
        did++;
        console.log(`[WorkerDedupe] left role=${loserAcc.role} account=${label} groupKey=${groupKey} winner=${item.winner.acc._id.toString()}`);
        await sleep(1200 + Math.random() * 1200);
      }
    } catch (err) {
      if (isFloodError(err)) await sleep(getFloodSeconds(err) * 1000);
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }
}

export async function runGroupJoiner(accountId, flag) {
  const acc = await Account.findById(accountId, 'role');
  if (!acc) { flag.running = false; return; }
  if (acc.role === 'finder') return runGroupFinder(accountId, flag);
  return runJoinFromDb(accountId, flag);
}
