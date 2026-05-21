import { Account, Admin, AiQueueMessage, ApprovedChat, BotSettings, GroupLink, InviteTicket, Keyword } from '../models/db.js';
import { runGroupJoiner, enforceUniqueWorkerGroupsOnce, syncListenerAndPreacherGroupsOnce } from '../helpers/groupJoiner.js';
import { createClient, sleep, isAuthError } from '../helpers/telegram.js';
import { Telegram } from 'telegraf';

// In-memory control flags per accountId
const joinFlags = new Map();
const WORKER_INSTANCE_ID = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
let pollerStarted = false;
let listenerDedupeRunning = false;
let spamBotSweepRunning = false;
let lastPollerErrorKey = null;
let lastPollerErrorAt = 0;

const botTelegram = new Telegram(process.env.BOT_TOKEN);
const SPAMBOT = process.env.SPAMBOT_USERNAME || 'SpamBot';
const SPAMBOT_JAIL_PATTERN = /harsh response from our anti-spam systems|submit a complaint to our moderators|while the account is limited/i;

async function notifyAllAdmins(text) {
  const admins = await Admin.find({ userId: { $ne: null } }, { userId: 1 }).lean();
  const ids = [...new Set(admins.map(a => a.userId).filter(Boolean))];
  await Promise.allSettled(ids.map((id) => botTelegram.sendMessage(id, text)));
}

async function deleteAccountCascade(accountId) {
  const id = accountId?.toString?.() || '';
  if (!id) return { deleted: false };

  const releasedClaimed = await GroupLink.updateMany(
    { claimedByAccountId: id },
    {
      $set: { status: 'new' },
      $unset: { claimedByAccountId: 1, claimedRole: 1, claimedAt: 1, lastError: 1 },
    }
  ).catch(() => null);

  const releasedJoined = await GroupLink.updateMany(
    { joinedByAccountId: id },
    {
      $set: { status: 'new' },
      $unset: { joinedByAccountId: 1, joinedRole: 1, joinedAt: 1, lastError: 1 },
    }
  ).catch(() => null);

  await GroupLink.updateMany(
    { foundByAccountId: id },
    { $set: { foundByAccountId: null } }
  ).catch(() => {});

  const deletedAi = await AiQueueMessage.deleteMany({ accountId: id }).catch(() => null);

  await Keyword.updateMany(
    { lockedByAccountId: id },
    { $set: { lockedByAccountId: null, lockedAt: null, lockExpiresAt: null } }
  ).catch(() => {});
  await Keyword.updateMany(
    { assignedToAccountId: id },
    { $set: { assignedToAccountId: null, assignedOrder: null } }
  ).catch(() => {});
  await Keyword.updateMany(
    { lastProcessedByAccountId: id },
    { $set: { lastProcessedByAccountId: null } }
  ).catch(() => {});

  await InviteTicket.updateMany(
    { inviterAccountId: id },
    { $set: { inviterAccountId: null } }
  ).catch(() => {});

  await ApprovedChat.updateMany(
    { inviteLinkByAccountId: id },
    { $set: { inviteLinkByAccountId: null } }
  ).catch(() => {});

  await BotSettings.updateMany(
    { $or: [{ inviterAccountId: id }, { inviterAccountIds: id }] },
    { $set: { inviterAccountId: null }, $pull: { inviterAccountIds: id } }
  ).catch(() => {});

  const del = await Account.deleteOne({ _id: accountId }).catch(() => null);

  return {
    deleted: (del?.deletedCount || 0) > 0,
    groupLinksReleasedClaimed: releasedClaimed?.modifiedCount ?? 0,
    groupLinksReleasedJoined: releasedJoined?.modifiedCount ?? 0,
    aiQueueDeleted: deletedAi?.deletedCount ?? 0,
  };
}

async function claimSpamBotLease(accountId, leaseMs) {
  const now = new Date();
  const expires = new Date(Date.now() + leaseMs);
  const updated = await Account.findOneAndUpdate(
    {
      _id: accountId,
      $or: [
        { spamBotLeaseExpiresAt: null },
        { spamBotLeaseExpiresAt: { $lte: now } },
        { spamBotLeaseId: WORKER_INSTANCE_ID },
      ],
    },
    {
      $set: {
        spamBotLeaseId: WORKER_INSTANCE_ID,
        spamBotLeaseExpiresAt: expires,
        spamBotLeaseUpdatedAt: now,
      },
    },
    { new: true }
  ).lean().catch(() => null);
  return !!updated;
}

async function releaseSpamBotLease(accountId) {
  await Account.updateOne(
    { _id: accountId, spamBotLeaseId: WORKER_INSTANCE_ID },
    { $unset: { spamBotLeaseId: 1, spamBotLeaseExpiresAt: 1 }, $set: { spamBotLeaseUpdatedAt: new Date() } }
  ).catch(() => {});
}

function pickLatestIncomingText(msgs = []) {
  const m = (msgs || []).find(x => x && !x.out && !x.action && typeof x.message === 'string' && x.message.trim());
  return m?.message || '';
}

async function checkSpamBotOnce(account) {
  const client = createClient(account.session, account._id);
  try {
    await client.connect();
    const refreshed = client.session.save();
    if (refreshed && refreshed !== account.session) {
      await Account.updateOne({ _id: account._id }, { session: refreshed }).catch(() => {});
    }

    const peer = await client.getEntity(SPAMBOT);
    await client.sendMessage(peer, { message: '/start' }).catch(() => {});
    await sleep(1200);
    const msgs = await client.getMessages(peer, { limit: 6 }).catch(() => []);
    const text = pickLatestIncomingText(msgs);
    const jailed = SPAMBOT_JAIL_PATTERN.test(text);

    await Account.updateOne(
      { _id: account._id },
      {
        $set: {
          spamBotLastCheckedAt: new Date(),
          spamBotLastStatus: jailed ? 'jailed' : 'ok',
          spamBotLastText: text || null,
        },
        ...(jailed ? { $setOnInsert: {} } : {}),
      }
    ).catch(() => {});

    if (jailed) {
      const label = account.username ? `@${account.username}` : account.number;
      const cleanup = await deleteAccountCascade(account._id);
      const details =
        `🚨 account has been jailed\n\n` +
        `role: preacher\n` +
        `accountId: ${account._id}\n` +
        `label: ${label}\n` +
        `userId: ${account.userId || 'n/a'}\n\n` +
        `SpamBot says:\n${text || '(no text)'}\n\n` +
        `Action: deleted account from DB\n` +
        `Cleanup: releasedClaimed=${cleanup.groupLinksReleasedClaimed} releasedJoined=${cleanup.groupLinksReleasedJoined} aiQueueDeleted=${cleanup.aiQueueDeleted}`;
      await notifyAllAdmins(details).catch(() => {});
    }
  } catch (err) {
    const msg = err?.message || 'spambot_check_failed';
    await Account.updateOne(
      { _id: account._id },
      { $set: { spamBotLastCheckedAt: new Date(), spamBotLastStatus: 'error', spamBotLastText: msg } }
    ).catch(() => {});
    if (isAuthError(err)) {
      await Account.updateOne(
        { _id: account._id },
        {
          $set: { session: null, isMessaging: false, isJoining: false, spamBotLastStatus: 'auth_error' },
          $unset: { joiningLeaseId: 1, joiningLeaseExpiresAt: 1, messagingLeaseId: 1, messagingLeaseExpiresAt: 1 },
        }
      ).catch(() => {});
      const label = account.username ? `@${account.username}` : account.number;
      await notifyAllAdmins(
        `⚠️ preacher session became invalid\n\naccountId: ${account._id}\nlabel: ${label}\nerror: ${msg}\n\nSession was cleared in DB (re-login required).`
      ).catch(() => {});
    }
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function spamBotSweepOnce(intervalMs) {
  const accounts = await Account.find(
    { role: 'preacher', session: { $nin: [null, ''] } },
    '_id username number userId session spamBotJailedAt'
  ).lean();

  for (const acc of accounts) {
    if (!acc?.session) continue;
    const leased = await claimSpamBotLease(acc._id, Math.max(60_000, intervalMs - 10_000));
    if (!leased) continue;
    try {
      await checkSpamBotOnce(acc);
    } finally {
      await releaseSpamBotLease(acc._id);
    }
    await sleep(500);
  }
}

async function claimJoiningLease(accountId) {
  const now = new Date();
  const expires = new Date(Date.now() + LEASE_MS);
  const updated = await Account.findOneAndUpdate(
    {
      _id: accountId,
      $or: [
        { joiningLeaseExpiresAt: null },
        { joiningLeaseExpiresAt: { $lte: now } },
        { joiningLeaseId: WORKER_INSTANCE_ID },
      ],
    },
    {
      $set: {
        isJoining: true,
        joiningLeaseId: WORKER_INSTANCE_ID,
        joiningLeaseExpiresAt: expires,
        joiningLeaseUpdatedAt: now,
        searchLimitHit: false,
      },
    },
    { new: true }
  ).lean().catch(() => null);
  return !!updated;
}

async function renewJoiningLease(accountId) {
  const now = new Date();
  const expires = new Date(Date.now() + LEASE_MS);
  const res = await Account.updateOne(
    { _id: accountId, joiningLeaseId: WORKER_INSTANCE_ID, isJoining: true },
    { $set: { joiningLeaseExpiresAt: expires, joiningLeaseUpdatedAt: now } }
  ).catch(() => {});
  return (res?.matchedCount || 0) > 0;
}

async function releaseJoiningLease(accountId, setStopped = false) {
  const patch = setStopped
    ? { $set: { isJoining: false, joiningLeaseUpdatedAt: new Date() }, $unset: { joiningLeaseId: 1, joiningLeaseExpiresAt: 1 } }
    : { $unset: { joiningLeaseId: 1, joiningLeaseExpiresAt: 1 }, $set: { joiningLeaseUpdatedAt: new Date() } };
  await Account.updateOne({ _id: accountId, joiningLeaseId: WORKER_INSTANCE_ID }, patch).catch(() => {});
}

export function isJoinWorkerRunning(accountId) {
  return joinFlags.get(accountId.toString())?.running === true;
}

export function isAnyJoinWorkerRunning() {
  return joinFlags.size > 0;
}

export async function startJoinWorker(accountId) {
  const id = accountId.toString();
  if (joinFlags.get(id)?.running) return;

  const acc = await Account.findById(accountId, 'role');
  if (!acc) return;
  if (acc.role === 'inviter') {
    await Account.updateOne({ _id: accountId }, { isJoining: false });
    return;
  }

  const leased = await claimJoiningLease(accountId);
  if (!leased) return;

  const flag = { running: true };
  joinFlags.set(id, flag);

  const renewTimer = setInterval(() => {
    renewJoiningLease(accountId).then((ok) => {
      if (!ok) flag.running = false;
    }).catch(() => {});
  }, RENEW_MS);
  if (renewTimer?.unref) renewTimer.unref();

  // Fire-and-forget async loop
  runGroupJoiner(accountId, flag).catch(err => {
    console.error(`[JoinWorker:${id}] Fatal:`, err.message);
    flag.running = false;
  }).finally(() => {
    clearInterval(renewTimer);
    joinFlags.delete(id);
    releaseJoiningLease(accountId, !flag.running).catch(() => {});
  });

  console.log(`[JoinWorker] Started for account ${id}`);
}

export async function stopJoinWorker(accountId) {
  const id = accountId.toString();
  const flag = joinFlags.get(id);
  if (flag) flag.running = false;
  joinFlags.delete(id);
  await Account.updateOne(
    { _id: accountId },
    { $set: { isJoining: false, joiningLeaseUpdatedAt: new Date() }, $unset: { joiningLeaseId: 1, joiningLeaseExpiresAt: 1 } }
  ).catch(() => {});
  console.log(`[JoinWorker] Stopped for account ${id}`);
}

export async function startAllJoinWorkers() {
  const accounts = await Account.find({ isJoining: true });
  for (const acc of accounts) {
    await startJoinWorker(acc._id);
  }
}

// Poller: checks every 60s for accounts whose search limit has expired → resumes them
export function startPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  const POLL_INTERVAL = 60000;
  const DEDUPE_INTERVAL = Math.max(1_000, Number(process.env.WORKER_GROUP_DEDUPE_INTERVAL_MS || 1_000));
  const GROUP_SYNC_INTERVAL = Math.max(60_000, Number(process.env.ACCOUNT_GROUPS_SYNC_INTERVAL_MS || 5 * 60 * 1000));
  const SPAMBOT_INTERVAL = Math.max(60_000, Number(process.env.SPAMBOT_CHECK_INTERVAL_MS || 5 * 60 * 1000));

  setInterval(async () => {
    try {
      const now = new Date();
      const accounts = await Account.find({
        searchLimitHit: true,
        searchLimitResetsAt: { $lte: now },
        isJoining: true,
      });

      for (const acc of accounts) {
        console.log(`[Poller] Search limit reset for ${acc.username || acc.number}, resuming joiner`);
        await Account.updateOne({ _id: acc._id }, { searchLimitHit: false, searchLimitResetsAt: null });
        await startJoinWorker(acc._id);
      }
    } catch (err) {
      const msg = err?.message || 'unknown error';
      const key = msg;
      const nowMs = Date.now();
      if (key !== lastPollerErrorKey || nowMs - lastPollerErrorAt > 30000) {
        lastPollerErrorKey = key;
        lastPollerErrorAt = nowMs;
        console.error('[Poller] Error:', msg);
      }
    }
  }, POLL_INTERVAL);

  syncListenerAndPreacherGroupsOnce().catch(() => {});
  const g = setInterval(() => {
    syncListenerAndPreacherGroupsOnce().catch(() => {});
  }, GROUP_SYNC_INTERVAL);
  if (g?.unref) g.unref();

  setInterval(async () => {
    if (listenerDedupeRunning) return;
    listenerDedupeRunning = true;
    try {
      await enforceUniqueWorkerGroupsOnce();
    } catch {}
    listenerDedupeRunning = false;
  }, DEDUPE_INTERVAL);

  const s = setInterval(async () => {
    if (spamBotSweepRunning) return;
    spamBotSweepRunning = true;
    try {
      await spamBotSweepOnce(SPAMBOT_INTERVAL);
    } catch {}
    spamBotSweepRunning = false;
  }, SPAMBOT_INTERVAL);
  if (s?.unref) s.unref();

  console.log('[Poller] Started (60s interval)');
}
