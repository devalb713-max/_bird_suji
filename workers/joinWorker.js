import { Account } from '../models/db.js';
import { runGroupJoiner, enforceUniqueListenerGroupsOnce, syncListenerAndPreacherGroupsOnce } from '../helpers/groupJoiner.js';

// In-memory control flags per accountId
const joinFlags = new Map();
const WORKER_INSTANCE_ID = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
let pollerStarted = false;
let listenerDedupeRunning = false;
let lastPollerErrorKey = null;
let lastPollerErrorAt = 0;

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
  const DEDUPE_INTERVAL = Math.max(60_000, Number(process.env.LISTENER_DEDUPE_INTERVAL_MS || 5 * 60 * 1000));
  const GROUP_SYNC_INTERVAL = Math.max(60_000, Number(process.env.ACCOUNT_GROUPS_SYNC_INTERVAL_MS || 5 * 60 * 1000));

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
      await enforceUniqueListenerGroupsOnce();
    } catch {}
    listenerDedupeRunning = false;
  }, DEDUPE_INTERVAL);

  console.log('[Poller] Started (60s interval)');
}
