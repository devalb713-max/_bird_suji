import 'dotenv/config';
import { Api } from 'telegram/tl/index.js';
import { connectDB, Account, ApprovedChat, BotSettings } from './models/db.js';
import { createClient, extractUsernameFromLink, sleep, isAuthError, isFloodError, getFloodSeconds } from './helpers/telegram.js';

function normalizeTmeLink(link) {
  try {
    const u = new URL(link);
    return `https://t.me/${u.pathname.replace(/^\//, '').toLowerCase()}`;
  } catch {
    return (link || '').toLowerCase().trim();
  }
}

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

function groupKey(g) {
  const link = g?.normalizedLink ? normalizeTmeLink(g.normalizedLink) : g?.link ? normalizeTmeLink(g.link) : '';
  if (link) return `link:${link}`;
  const id = g?.id?.toString?.() || '';
  if (id) return `id:${id}`;
  return null;
}

function accountLabel(acc) {
  return acc?.username || acc?.number || acc?._id?.toString?.() || 'account';
}

function pickWinner(entries) {
  const listeners = entries.filter(e => e?.account?.role === 'listener');
  const pool = listeners.length ? listeners : entries;
  pool.sort((a, b) => {
    const ta = a?.account?.createdAt ? new Date(a.account.createdAt).getTime() : 0;
    const tb = b?.account?.createdAt ? new Date(b.account.createdAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.account._id.toString().localeCompare(b.account._id.toString());
  });
  return pool[0] || null;
}

function isApprovedById(internalId, approvedIdSet) {
  const id = internalId?.toString?.() || '';
  if (!id) return false;
  return approvedIdSet.has(id) || approvedIdSet.has(`-${id}`) || approvedIdSet.has(`-100${id}`);
}

async function loadApprovedContext() {
  const [settings, rows] = await Promise.all([
    BotSettings.findOne({}, { requiredGroupInviteLink: 1 }).lean().catch(() => null),
    ApprovedChat.find({ type: 'group' }, { chatId: 1, inviteLink: 1 }).lean().catch(() => []),
  ]);

  const approvedIds = new Set((rows || []).map(r => (r?.chatId || '').toString()).filter(Boolean));
  const approvedLinks = new Set();

  const req = settings?.requiredGroupInviteLink ? normalizeTmeLink(settings.requiredGroupInviteLink) : '';
  if (req) approvedLinks.add(req);

  for (const r of rows || []) {
    const l = r?.inviteLink ? normalizeTmeLink(r.inviteLink) : '';
    if (l) approvedLinks.add(l);
  }

  return { approvedIds, approvedLinks };
}

async function resolveEntityForGroup(client, group) {
  const username = extractUsernameFromLink(group?.link || '');
  if (username) {
    const ent = await client.getEntity(username).catch(() => null);
    if (ent) return ent;
  }
  const id = group?.id?.toString?.() || '';
  if (id) {
    const ent = await client.getEntity(id).catch(() => null);
    if (ent) return ent;
    try {
      const ent2 = await client.getEntity(BigInt(id)).catch(() => null);
      if (ent2) return ent2;
    } catch {}
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

async function leaveGroupForAccount(acc, group) {
  const client = createClient(acc.session, acc._id);
  try {
    await client.connect();
    const entity = await resolveEntityForGroup(client, group);
    if (!entity) return { ok: false, error: 'entity_resolve_failed' };
    await leaveEntity(client, entity);
    await Account.updateOne(
      { _id: acc._id },
      {
        $pull: {
          groups: {
            $or: [
              group?.id ? { id: group.id.toString() } : null,
              group?.normalizedLink ? { normalizedLink: normalizeTmeLink(group.normalizedLink) } : null,
              group?.link ? { link: group.link.toString() } : null,
            ].filter(Boolean),
          },
        },
      }
    ).catch(() => {});
    return { ok: true };
  } catch (err) {
    const msg = (err?.message || '').toString();
    if (msg.includes('USER_NOT_PARTICIPANT')) {
      await Account.updateOne(
        { _id: acc._id },
        {
          $pull: {
            groups: {
              $or: [
                group?.id ? { id: group.id.toString() } : null,
                group?.normalizedLink ? { normalizedLink: normalizeTmeLink(group.normalizedLink) } : null,
                group?.link ? { link: group.link.toString() } : null,
              ].filter(Boolean),
            },
          },
        }
      ).catch(() => {});
      return { ok: true };
    }
    if (isFloodError(err)) {
      const secs = getFloodSeconds(err);
      await sleep(secs * 1000);
      return { ok: false, error: `flood_${secs}s` };
    }
    if (isAuthError(err)) return { ok: false, error: 'auth_error' };
    return { ok: false, error: msg || 'leave_failed' };
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

await connectDB();

const startedAt = new Date().toISOString();
console.log(JSON.stringify({ event: 'dedupe.start', at: startedAt }));

const { approvedIds, approvedLinks } = await loadApprovedContext();
console.log(JSON.stringify({ event: 'dedupe.approved_loaded', approvedIds: approvedIds.size, approvedLinks: approvedLinks.size }));

const accounts = await Account.find(
  { role: { $in: ['listener', 'preacher'] }, session: { $nin: [null, ''] } },
  { _id: 1, role: 1, createdAt: 1, session: 1, groups: 1, username: 1, number: 1 }
).sort({ createdAt: 1 }).lean();

console.log(JSON.stringify({ event: 'dedupe.accounts_loaded', count: accounts.length }));

const membership = new Map();
let syncOk = 0;
let syncFail = 0;

for (const acc of accounts) {
  const label = accountLabel(acc);
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
    syncOk += 1;
    console.log(JSON.stringify({ event: 'dedupe.sync_ok', accountId: acc._id.toString(), role: acc.role, groups: groups.length }));

    for (const g of groups) {
      const key = groupKey(g);
      if (!key) continue;
      const arr = membership.get(key) || [];
      arr.push({ account: acc, group: g });
      membership.set(key, arr);
    }
  } catch (err) {
    syncFail += 1;
    const msg = isAuthError(err) ? 'auth_error' : isFloodError(err) ? `flood_${getFloodSeconds(err)}s` : (err?.message || 'sync_failed').toString();
    await Account.updateOne({ _id: acc._id }, { $set: { groupsSyncedAt: new Date(), groupsSyncError: msg.slice(0, 180) } }).catch(() => {});
    console.log(JSON.stringify({ event: 'dedupe.sync_fail', accountId: acc._id.toString(), role: acc.role, error: msg }));
    if (isFloodError(err)) await sleep(getFloodSeconds(err) * 1000);
  } finally {
    try { await client.disconnect(); } catch {}
  }
  await sleep(1200 + Math.random() * 1200);
}

console.log(JSON.stringify({ event: 'dedupe.sync_done', ok: syncOk, fail: syncFail, keys: membership.size }));

let overlaps = 0;
let leaveAttempts = 0;
let leftOk = 0;
let leftFail = 0;

for (const [key, entries] of membership.entries()) {
  if (!entries || entries.length <= 1) continue;
  const sample = entries[0]?.group || null;
  const gid = sample?.id?.toString?.() || '';
  const glink = sample?.normalizedLink ? normalizeTmeLink(sample.normalizedLink) : sample?.link ? normalizeTmeLink(sample.link) : '';
  const approved = (gid && isApprovedById(gid, approvedIds)) || (glink && approvedLinks.has(glink));
  if (approved) continue;

  overlaps += 1;
  const winner = pickWinner(entries);
  const losers = entries.filter(e => e?.account?._id?.toString?.() !== winner?.account?._id?.toString?.());
  console.log(JSON.stringify({
    event: 'dedupe.overlap',
    key,
    groupId: gid || null,
    groupLink: glink || null,
    winner: winner ? { accountId: winner.account._id.toString(), role: winner.account.role, label: accountLabel(winner.account) } : null,
    losers: losers.map(l => ({ accountId: l.account._id.toString(), role: l.account.role, label: accountLabel(l.account) })),
  }));

  for (const loser of losers) {
    leaveAttempts += 1;
    const res = await leaveGroupForAccount(loser.account, loser.group);
    if (res.ok) leftOk += 1;
    else leftFail += 1;
    console.log(JSON.stringify({
      event: 'dedupe.leave',
      key,
      groupId: gid || null,
      groupLink: glink || null,
      accountId: loser.account._id.toString(),
      role: loser.account.role,
      label: accountLabel(loser.account),
      ok: res.ok,
      error: res.ok ? null : res.error,
    }));
    await sleep(1800 + Math.random() * 1800);
  }
}

const finishedAt = new Date().toISOString();
console.log(JSON.stringify({
  event: 'dedupe.done',
  at: finishedAt,
  overlaps,
  leaveAttempts,
  leftOk,
  leftFail,
}));

process.exit(0);
