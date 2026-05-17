import { Account } from '../models/db.js';
import { runMessenger } from '../helpers/messenger.js';

const messageFlags = new Map();

export function isMessageWorkerRunning(accountId) {
  return messageFlags.get(accountId.toString())?.running === true;
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

  const flag = { running: true };
  messageFlags.set(id, flag);

  await Account.updateOne({ _id: accountId }, { isMessaging: true });

  runMessenger(accountId, flag).catch(err => {
    console.error(`[MessageWorker:${id}] Fatal:`, err.message);
    flag.running = false;
  }).finally(() => {
    messageFlags.delete(id);
  });

  console.log(`[MessageWorker] Started for account ${id}`);
}

export async function stopMessageWorker(accountId) {
  const id = accountId.toString();
  const flag = messageFlags.get(id);
  if (flag) flag.running = false;
  await Account.updateOne({ _id: accountId }, { isMessaging: false });
  console.log(`[MessageWorker] Stopped for account ${id}`);
}

export async function startAllMessageWorkers() {
  const accounts = await Account.find({});
  for (const acc of accounts) {
    await startMessageWorker(acc._id);
  }
}
