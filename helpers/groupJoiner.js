import { Api } from 'telegram/tl/index.js';
import { Account, Keyword, BotChat, GroupLink } from '../models/db.js';
import { createClient, sendWithTyping, extractUsernameFromLink, extractInviteHash, sleep, isFloodError, getFloodSeconds, isAuthError } from './telegram.js';
import { addGroup } from './groupRegistry.js';

const SEARCH_BOT = process.env.SEARCH_BOT_USERNAME || 'en_SearchBot';
const DAILY_LIMIT_PATTERN = /you have reached your daily usage limit/i;
const NO_RESULTS_PATTERN = /sorry,?\s*no link found/i;

function isSearchLimitMessage(text = '') {
  return DAILY_LIMIT_PATTERN.test(text) || text.includes('t.me/OKSearch?start=');
}

function isNoResultsMessage(text = '') {
  return NO_RESULTS_PATTERN.test(text);
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

async function getAllPreacherGroupLinks(exceptAccountId) {
  const q = { role: 'preacher' };
  const accounts = await Account.find(q, 'groups.link _id');
  const links = new Set();
  for (const acc of accounts) {
    if (exceptAccountId && acc._id?.toString() === exceptAccountId.toString()) continue;
    for (const g of acc.groups) {
      if (g.link) links.add(normalizeTmeLink(g.link));
    }
  }
  return links;
}

async function clickButtonAndWait(client, botEntity, msgId, btn, waitMs = 4000, previousMsgId = null, previousText = null) {
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
    const msgs = await client.getMessages(SEARCH_BOT, { limit: 8 });
    const next = msgs.find(isValidBotResultMessage) || null;
    if (!next) continue;

    if (previousMsgId && next.id === previousMsgId) continue;
    const txt = next.message || '';
    if (previousText && txt && txt === previousText) continue;
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
  return Keyword.findOneAndUpdate(
    {
      $or: [
        { lockExpiresAt: null },
        { lockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        lockedByAccountId: accountId.toString(),
        lockedAt: now,
        lockExpiresAt: lockUntil,
      },
    },
    { sort: { createdAt: 1 }, new: true }
  );
}

async function releaseKeyword(keywordDoc, accountId) {
  if (!keywordDoc?._id) return;
  await Keyword.updateOne(
    { _id: keywordDoc._id, lockedByAccountId: accountId.toString() },
    { $set: { lockedByAccountId: null, lockedAt: null, lockExpiresAt: null } }
  ).catch(() => {});
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
  if (!links.length) return 0;

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
    return res?.length || 0;
  } catch {
    return 0;
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

      keywordDoc = await claimNextKeyword(accountId);
      const keyword = keywordDoc?.word || null;
      if (!keyword) {
        await client.disconnect();
        await sleep(300000);
        continue;
      }

      await client.sendMessage(botEntity, { message: '/start' });
      await sleep(3000 + Math.random() * 3000);
      await sendWithTyping(client, botEntity, keyword);
      await sleep(4000 + Math.random() * 3000);

      const msgs = await client.getMessages(SEARCH_BOT, { limit: 6 });
      let reply = msgs.find(isValidBotResultMessage);
      if (!reply) {
        const plainBotMsg = msgs.find(m => !m.out && m.message);
        if (plainBotMsg && isSearchLimitMessage(plainBotMsg.message || '')) {
          const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await Account.updateOne(
            { _id: accountId },
            { searchLimitHit: true, searchLimitResetsAt: resetsAt, isJoining: false }
          );
          flag.running = false;
          await releaseKeyword(keywordDoc, accountId);
          await client.disconnect();
          return;
        }
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(15000);
        continue;
      }

      const allBtns = reply.replyMarkup?.rows?.flatMap(r => r.buttons) || [];
      const groupsBtn = allBtns.find(b => b.text === '👥');
      if (!groupsBtn) {
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(10000);
        continue;
      }
      const prevGroupsMsgId = reply.id;
      const prevGroupsText = reply.message || null;
      reply = await clickButtonAndWait(client, botEntity, reply.id, groupsBtn, 5000 + Math.random() * 3000, prevGroupsMsgId, prevGroupsText);
      if (!reply) {
        await client.disconnect();
        await releaseKeyword(keywordDoc, accountId);
        await sleep(10000);
        continue;
      }

      let pageNum = 1;
      while (flag.running) {
        const groupLinks = extractGroupLinks(reply);
        const stored = await storeDiscoveredLinks(groupLinks, keyword, accountId);
        if (stored) {
          console.log(`[Finder:${label}] Page ${pageNum} "${keyword}" stored ${stored}/${groupLinks.length}`);
        } else {
          console.log(`[Finder:${label}] Page ${pageNum} "${keyword}" (0 new)`);
        }

        const pageBtns = reply.replyMarkup?.rows?.flatMap(r => r.buttons) || [];
        const nextBtn = pageBtns.find(b => b.text === '➡️');
        if (!nextBtn) break;
        const prevMsgId = reply.id;
        const prevText = reply.message || null;
        reply = await clickButtonAndWait(client, botEntity, reply.id, nextBtn, 8000 + Math.random() * 7000, prevMsgId, prevText);
        if (!reply) break;
        pageNum++;
        await sleep(3000 + Math.random() * 4000);
      }

      await client.disconnect();
      await releaseKeyword(keywordDoc, accountId);

    } catch (err) {
      try { await client.disconnect(); } catch {}
      await releaseKeyword(keywordDoc, accountId);
      if (isAuthError(err)) {
        await Account.updateOne({ _id: accountId }, { isJoining: false, isMessaging: false });
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
    if (role === 'preacher') {
      const preacherLinks = await getAllPreacherGroupLinks(accountId);
      if (preacherLinks.has(link)) {
        await GroupLink.deleteOne({ _id: linkDoc._id });
        await sleep(3000 + Math.random() * 3000);
        continue;
      }
    }

    const client = createClient(account.session, accountId);
    try {
      await client.connect();
      const refreshed = client.session.save();
      if (refreshed && refreshed !== account.session) {
        await Account.updateOne({ _id: accountId }, { session: refreshed });
      }

      const { joined, entity: joinedEntity } = await joinGroupLink(client, link);
      if (!joined) {
        const nextStatus = (linkDoc.attempts || 0) >= 3 ? 'dead' : 'new';
        await markLink(linkDoc, { status: nextStatus, lastError: 'join_failed' });
        await client.disconnect();
        await sleep(5000 + Math.random() * 5000);
        continue;
      }

      let groupInfo = { link, name: link, id: link };
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
        };
      }

      if (role === 'preacher' && resolvedEntity?.defaultBannedRights?.sendMessages) {
        try { await client.invoke(new Api.channels.LeaveChannel({ channel: resolvedEntity })); } catch {}
        await markLink(linkDoc, { status: 'dead', lastError: 'cannot_send_messages' });
        await client.disconnect();
        await sleep(5000 + Math.random() * 5000);
        continue;
      }

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

export async function runGroupJoiner(accountId, flag) {
  const acc = await Account.findById(accountId, 'role');
  if (!acc) { flag.running = false; return; }
  if (acc.role === 'finder') return runGroupFinder(accountId, flag);
  return runJoinFromDb(accountId, flag);
}
