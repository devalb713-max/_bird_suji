import { Account } from '../models/db.js';
import { runMessenger } from '../helpers/messenger.js';

const messageFlags = new Map();
const WORKER_INSTANCE_ID = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 60_000;
const RENEW_MS = 20_000;

async function claimMessagingLease(accountId) {
  const now = new Date();
  const expires = new Date(Date.now() + LEASE_MS);
  const updated = await Account.findOneAndUpdate(
    {
      _id: accountId,
      $or: [
        { messagingLeaseExpiresAt: null },
        { messagingLeaseExpiresAt: { $lte: now } },
        { messagingLeaseId: WORKER_INSTANCE_ID },
      ],
    },
    {
      $set: {
        isMessaging: true,
        messagingLeaseId: WORKER_INSTANCE_ID,
        messagingLeaseExpiresAt: expires,
        messagingLeaseUpdatedAt: now,
      },
    },
    { new: true }
  ).lean().catch(() => null);
  return !!updated;
}

async function renewMessagingLease(accountId) {
  const now = new Date();
  const expires = new Date(Date.now() + LEASE_MS);
  const res = await Account.updateOne(
    { _id: accountId, messagingLeaseId: WORKER_INSTANCE_ID, isMessaging: true },
    { $set: { messagingLeaseExpiresAt: expires, messagingLeaseUpdatedAt: now } }
  ).catch(() => {});
  return (res?.matchedCount || 0) > 0;
}

async function releaseMessagingLease(accountId, setStopped = false) {
  const patch = setStopped
    ? { $set: { isMessaging: false, messagingLeaseUpdatedAt: new Date() }, $unset: { messagingLeaseId: 1, messagingLeaseExpiresAt: 1 } }
    : { $unset: { messagingLeaseId: 1, messagingLeaseExpiresAt: 1 }, $set: { messagingLeaseUpdatedAt: new Date() } };
  await Account.updateOne({ _id: accountId, messagingLeaseId: WORKER_INSTANCE_ID }, patch).catch(() => {});
}

export function isMessageWorkerRunning(accountId) {
  return messageFlags.get(accountId.toString())?.running === true;
}

export function isAnyMessageWorkerRunning() {
  return messageFlags.size > 0;
}

export async function startMessageWorker(accountId) {
  const id = accountId.toString();
  if (messageFlags.get(id)?.running) return;

  const acc = await Account.findById(accountId, 'role');
  if (!acc) return;
  if (acc.role !== 'listener' && acc.role !== 'preacher') {
    await Account.updateOne({ _id: accountId }, { isMessaging: false });
    return;
  }

  const leased = await claimMessagingLease(accountId);
  if (!leased) return;

  const flag = { running: true };
  messageFlags.set(id, flag);
  const renewTimer = setInterval(() => {
    renewMessagingLease(accountId).then((ok) => {
      if (!ok) flag.running = false;
    }).catch(() => {});
  }, RENEW_MS);
  if (renewTimer?.unref) renewTimer.unref();

  runMessenger(accountId, flag).catch(err => {
    console.error(`[MessageWorker:${id}] Fatal:`, err.message);
    flag.running = false;
  }).finally(() => {
    clearInterval(renewTimer);
    messageFlags.delete(id);
    releaseMessagingLease(accountId, !flag.running).catch(() => {});
  });

  console.log(`[MessageWorker] Started for account ${id}`);
}

export async function stopMessageWorker(accountId) {
  const id = accountId.toString();
  const flag = messageFlags.get(id);
  if (flag) flag.running = false;
  messageFlags.delete(id);
  await Account.updateOne(
    { _id: accountId },
    { $set: { isMessaging: false, messagingLeaseUpdatedAt: new Date() }, $unset: { messagingLeaseId: 1, messagingLeaseExpiresAt: 1 } }
  ).catch(() => {});
  console.log(`[MessageWorker] Stopped for account ${id}`);
}

export async function startAllMessageWorkers() {
  const accounts = await Account.find({ isMessaging: true });
  for (const acc of accounts) {
    await startMessageWorker(acc._id);
  }
}
