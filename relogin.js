import 'dotenv/config';
import readline from 'readline';
import { connectDB } from './models/db.js';
import { Account } from './models/db.js';
import { createClient, getDCAddress, sleep } from './helpers/telegram.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { randomFingerprint } from './helpers/fingerprint.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function sendCode(phone) {
  const fp = randomFingerprint();
  let client = new TelegramClient(new StringSession(''), parseInt(process.env.API_ID), process.env.API_HASH, {
    connectionRetries: 5, timeout: 30000, requestRetries: 3,
    deviceModel: fp.deviceModel, systemVersion: fp.systemVersion,
    appVersion: fp.appVersion, langCode: fp.langCode, systemLangCode: fp.systemLangCode,
  });

  await client.connect();

  try {
    const result = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone,
      apiId: parseInt(process.env.API_ID),
      apiHash: process.env.API_HASH,
      settings: new Api.CodeSettings({
        allowFlashcall: true,
        currentNumber: true,
        allowAppHash: true,
        allowMissedCall: true,
      }),
    }));
    return { client, phoneCodeHash: result.phoneCodeHash };
  } catch (err) {
    if (err.message?.startsWith('PHONE_MIGRATE_')) {
      const dcId = parseInt(err.message.split('_').pop(), 10);
      await client.disconnect().catch(() => {});
      const fp2 = randomFingerprint();
      client = new TelegramClient(new StringSession(''), parseInt(process.env.API_ID), process.env.API_HASH, {
        connectionRetries: 5, timeout: 30000, requestRetries: 3,
        initialServerAddress: getDCAddress(dcId),
        deviceModel: fp2.deviceModel, systemVersion: fp2.systemVersion,
        appVersion: fp2.appVersion, langCode: fp2.langCode, systemLangCode: fp2.systemLangCode,
      });
      await client.connect();
      const result = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: parseInt(process.env.API_ID),
        apiHash: process.env.API_HASH,
        settings: new Api.CodeSettings({
          allowFlashcall: true, currentNumber: true, allowAppHash: true, allowMissedCall: true,
        }),
      }));
      return { client, phoneCodeHash: result.phoneCodeHash };
    }
    throw err;
  }
}

async function loginAccount(account) {
  const label = account.username ? `@${account.username}` : account.number;
  console.log(`\n─── ${label} (${account.number}) ───`);

  let client, phoneCodeHash;
  try {
    console.log('Sending verification code...');
    ({ client, phoneCodeHash } = await sendCode(account.number));
    console.log('Code sent. Check your Telegram app or SMS.');
  } catch (err) {
    console.error(`Failed to send code: ${err.message}`);
    return false;
  }

  let signedIn = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await ask('Enter the code (or "skip" to skip this account): ')).trim();
    if (code.toLowerCase() === 'skip') {
      await client.disconnect().catch(() => {});
      return false;
    }

    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: account.number,
        phoneCodeHash,
        phoneCode: code,
      }));
      signedIn = true;
      break;
    } catch (err) {
      if (err.code === 401 && err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        // 2FA required
        for (let pwAttempt = 0; pwAttempt < 3; pwAttempt++) {
          const password = (await ask('Two-factor password required. Enter password (or "skip"): ')).trim();
          if (password.toLowerCase() === 'skip') break;
          try {
            const passwordInfo = await client.invoke(new Api.account.GetPassword());
            const { computeCheck } = await import('telegram/Password.js');
            const hash = await computeCheck(passwordInfo, password);
            await client.invoke(new Api.auth.CheckPassword({ password: hash }));
            signedIn = true;
            break;
          } catch (pwErr) {
            if (pwErr.errorMessage === 'PASSWORD_HASH_INVALID') {
              console.error('Wrong password, try again.');
            } else {
              console.error(`2FA error: ${pwErr.message}`);
              break;
            }
          }
        }
        break;
      }
      if (err.errorMessage === 'PHONE_CODE_INVALID' || err.errorMessage === 'PHONE_CODE_EXPIRED') {
        console.error(`Code error: ${err.errorMessage}${attempt < 2 ? ' — try again' : ''}`);
        if (attempt === 2) break;
        continue;
      }
      console.error(`Sign-in error: ${err.message}`);
      break;
    }
  }

  if (!signedIn) {
    await client.disconnect().catch(() => {});
    console.log('Login failed — skipping.');
    return false;
  }

  try {
    const me = await client.getMe();
    const session = client.session.save();
    await client.disconnect().catch(() => {});

    await Account.updateOne(
      { _id: account._id },
      {
        session,
        username: me.username || account.username || null,
        userId: me.id?.toString() || null,
      }
    );
    console.log(`✓ Logged in as ${me.username ? '@' + me.username : me.phone} — session saved.`);
    return true;
  } catch (err) {
    console.error(`Failed to save session: ${err.message}`);
    return false;
  }
}

async function main() {
  await connectDB();

  // Target: accounts with no session, or where session is empty string
  const accounts = await Account.find({ $or: [{ session: null }, { session: '' }] });

  if (!accounts.length) {
    console.log('No accounts need re-login (all have sessions).');
    rl.close();
    process.exit(0);
  }

  console.log(`Found ${accounts.length} account(s) needing re-login:`);
  for (const acc of accounts) {
    console.log(`  • ${acc.username ? '@' + acc.username : acc.number}`);
  }

  let succeeded = 0;
  let skipped = 0;

  for (const account of accounts) {
    const ok = await loginAccount(account);
    if (ok) succeeded++;
    else skipped++;
    if (account !== accounts[accounts.length - 1]) {
      await sleep(3000);
    }
  }

  console.log(`\nDone. ${succeeded} logged in, ${skipped} skipped.`);
  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
