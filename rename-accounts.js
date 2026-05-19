import 'dotenv/config';
import mongoose from 'mongoose';
import { Api } from 'telegram/tl/index.js';
import { connectDB, Account } from './models/db.js';
import { createClient } from './helpers/telegram.js';

function toRoleLabel(role) {
  return role === 'finder' ? 'groupfinder' : role || 'listener';
}

function buildDesiredIdentity({ userId, phoneNumber, role }) {
  const roleLabel = toRoleLabel(role);
  const rawId = (userId || '').toString().trim() || (phoneNumber || '').toString().replace(/\D/g, '');
  const idPrefix = rawId.toString().replace(/\D/g, '').slice(0, 5) || rawId.toString().slice(0, 5);
  const displayName = `${roleLabel}_${idPrefix}`;
  let username = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 32);
  if (username.length < 5) username = null;
  return { displayName, username };
}

async function renameOneAccount(acc) {
  if (!acc?.session) return { ok: false, reason: 'no_session' };
  const client = createClient(acc.session, acc._id?.toString?.() || null);
  try {
    await client.connect();
    const me = await client.getMe();
    const { displayName, username } = buildDesiredIdentity({
      userId: me?.id?.toString?.() || acc.userId,
      phoneNumber: acc.number,
      role: acc.role,
    });

    await client.invoke(new Api.account.UpdateProfile({ firstName: displayName, lastName: '' })).catch(() => {});
    let usernameSet = false;
    if (username) {
      const res = await client.invoke(new Api.account.UpdateUsername({ username })).then(() => true).catch(() => false);
      usernameSet = !!res;
    }

    const sessionString = client.session.save();
    await Account.updateOne(
      { _id: acc._id },
      {
        $set: {
          session: sessionString,
          userId: me?.id?.toString?.() || acc.userId || null,
          username: usernameSet ? username : (acc.username || me?.username || null),
        },
      }
    ).catch(() => {});

    return { ok: true, displayName, username: usernameSet ? username : null };
  } catch (err) {
    return { ok: false, reason: err?.message || 'failed' };
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI in env.');
  if (!process.env.API_ID || !process.env.API_HASH) throw new Error('Missing API_ID/API_HASH in env.');

  await connectDB();

  const accounts = await Account.find({ session: { $ne: null } })
    .select({ number: 1, role: 1, session: 1, userId: 1, username: 1 })
    .lean();

  let ok = 0;
  let fail = 0;

  for (const acc of accounts) {
    const res = await renameOneAccount(acc);
    if (res.ok) {
      ok++;
      console.log(`✅ ${acc.role} ${acc.number}: name=${res.displayName}${res.username ? ` username=@${res.username}` : ''}`);
    } else {
      fail++;
      console.log(`❌ ${acc.role} ${acc.number}: ${res.reason}`);
    }
  }

  console.log(`Done. OK=${ok} FAIL=${fail}`);
  await mongoose.disconnect().catch(() => {});
}

(() => {
  void (async () => {
    try {
      await main();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    }
  })();
})();
