import 'dotenv/config';
import { connectDB, BotUser } from './models/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function hasFlag(name) {
  return process.argv.includes(name);
}

const APPLY = !hasFlag('--dry-run');
const now = Date.now();
const cutoffMs = now - DAY_MS;
const cutoff = new Date(cutoffMs);

if (!process.env.MONGODB_URI) {
  console.error('Missing MONGODB_URI in environment.');
  process.exit(1);
}

await connectDB();

const filter = {
  bannedAt: null,
  removedAt: null,
  trialStartedAt: { $ne: null, $lte: cutoff },
  trialEndsAt: { $ne: null },
  subscriptionEndsAt: null,
  pendingSubscriptionMonths: { $lte: 0 },
};

let matched = 0;
let ops = [];
let modified = 0;
let sampleShown = 0;
const SAMPLE_MAX = 25;

async function flush() {
  if (!ops.length) return;
  const res = await BotUser.bulkWrite(ops, { ordered: false }).catch(() => null);
  if (res) modified += res.modifiedCount || 0;
  ops = [];
}

console.log(JSON.stringify({ event: 'trial_gift.start', now: new Date(now).toISOString(), cutoff: cutoff.toISOString(), apply: APPLY }));

const cursor = BotUser.find(filter, { _id: 1, userId: 1, username: 1, trialStartedAt: 1, trialEndsAt: 1 }).cursor();

for await (const u of cursor) {
  matched += 1;
  const oldEnds = u.trialEndsAt ? new Date(u.trialEndsAt).getTime() : 0;
  if (!oldEnds) continue;
  const newEnds = new Date(oldEnds + DAY_MS);

  if (sampleShown < SAMPLE_MAX) {
    sampleShown += 1;
    console.log(JSON.stringify({
      event: 'trial_gift.sample',
      userId: u.userId?.toString?.() || null,
      username: u.username || null,
      trialStartedAt: u.trialStartedAt ? new Date(u.trialStartedAt).toISOString() : null,
      oldTrialEndsAt: u.trialEndsAt ? new Date(u.trialEndsAt).toISOString() : null,
      newTrialEndsAt: newEnds.toISOString(),
    }));
  }

  if (!APPLY) continue;

  ops.push({
    updateOne: {
      filter: { _id: u._id },
      update: {
        $set: {
          trialEndsAt: newEnds,
          trialReminder8hSentAt: null,
          trialReminder2hSentAt: null,
        },
      },
    },
  });

  if (ops.length >= 500) {
    await flush();
  }
}

if (APPLY) await flush();

console.log(JSON.stringify({ event: 'trial_gift.done', matched, modified, apply: APPLY }));
process.exit(0);

