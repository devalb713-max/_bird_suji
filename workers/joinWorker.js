import { Account } from '../models/db.js';
import { runGroupJoiner } from '../helpers/groupJoiner.js';

// In-memory control flags per accountId
const joinFlags = new Map();

export function isJoinWorkerRunning(accountId) {
  return joinFlags.get(accountId.toString())?.running === true;
}

export async function startJoinWorker(accountId) {
  const id = accountId.toString();
  if (joinFlags.get(id)?.running) return;

  const acc = await Account.findById(accountId, 'role');
  if (!acc) return;
  if (acc.role === 'inviter' || acc.role === 'preacher') {
    await Account.updateOne({ _id: accountId }, { isJoining: false });
    return;
  }

  const flag = { running: true };
  joinFlags.set(id, flag);

  await Account.updateOne({ _id: accountId }, { isJoining: true, searchLimitHit: false });

  // Fire-and-forget async loop
  runGroupJoiner(accountId, flag).catch(err => {
    console.error(`[JoinWorker:${id}] Fatal:`, err.message);
    flag.running = false;
  }).finally(() => {
    joinFlags.delete(id);
  });

  console.log(`[JoinWorker] Started for account ${id}`);
}

export async function stopJoinWorker(accountId) {
  const id = accountId.toString();
  const flag = joinFlags.get(id);
  if (flag) flag.running = false;
  await Account.updateOne({ _id: accountId }, { isJoining: false });
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
  const POLL_INTERVAL = 60000;

  setInterval(async () => {
    try {
      const now = new Date();
      const accounts = await Account.find({
        searchLimitHit: true,
        searchLimitResetsAt: { $lte: now },
      });

      for (const acc of accounts) {
        console.log(`[Poller] Search limit reset for ${acc.username || acc.number}, resuming joiner`);
        await Account.updateOne({ _id: acc._id }, { searchLimitHit: false, searchLimitResetsAt: null });
        await startJoinWorker(acc._id);
      }
    } catch (err) {
      console.error('[Poller] Error:', err.message);
    }
  }, POLL_INTERVAL);

  console.log('[Poller] Started (60s interval)');
}
