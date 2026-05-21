import "dotenv/config";
import mongoose from "mongoose";
import {
  connectDB,
  Account,
  AiQueueMessage,
  ApprovedChat,
  BotSettings,
  GroupLink,
  InviteTicket,
  Keyword,
} from "./models/db.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function asInt(value, fallback) {
  if (value == null) return fallback;
  const s = value.toString().trim();
  if (!s) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function deleteAccountCascade(accountId) {
  const id = accountId?.toString?.() || "";
  if (!id) return { deleted: false };

  const releasedClaimed = await GroupLink.updateMany(
    { claimedByAccountId: id },
    {
      $set: { status: "new" },
      $unset: { claimedByAccountId: 1, claimedRole: 1, claimedAt: 1, lastError: 1 },
    }
  ).catch(() => null);

  const releasedJoined = await GroupLink.updateMany(
    { joinedByAccountId: id },
    {
      $set: { status: "new" },
      $unset: { joinedByAccountId: 1, joinedRole: 1, joinedAt: 1, lastError: 1 },
    }
  ).catch(() => null);

  await GroupLink.updateMany({ foundByAccountId: id }, { $set: { foundByAccountId: null } }).catch(() => {});

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

  await InviteTicket.updateMany({ inviterAccountId: id }, { $set: { inviterAccountId: null } }).catch(() => {});
  await ApprovedChat.updateMany({ inviteLinkByAccountId: id }, { $set: { inviteLinkByAccountId: null } }).catch(() => {});
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

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in env.");
  }

  const apply = hasFlag("--apply");
  const dryRun = !apply;
  const limit = asInt(getArg("--limit", null), null);

  await connectDB();

  const match = {
    role: "preacher",
    $or: [{ spamBotLastStatus: "jailed" }, { spamBotJailedAt: { $ne: null } }],
  };

  const total = await Account.countDocuments(match);
  console.log(JSON.stringify({ event: "purge.start", dryRun, apply, total, limit: limit ?? null }));

  const cursor = Account.find(match).sort({ spamBotJailedAt: -1, updatedAt: -1 }).lean().cursor();

  let processed = 0;
  let deleted = 0;
  for await (const acc of cursor) {
    if (limit != null && processed >= limit) break;
    processed++;

    const label = acc.username ? `@${acc.username}` : acc.number;
    if (dryRun) {
      console.log(JSON.stringify({
        event: "purge.match",
        accountId: acc._id?.toString?.() || null,
        label,
        spamBotLastStatus: acc.spamBotLastStatus || null,
        spamBotJailedAt: acc.spamBotJailedAt || null,
      }));
      continue;
    }

    const cleanup = await deleteAccountCascade(acc._id);
    if (cleanup.deleted) deleted++;
    console.log(JSON.stringify({
      event: "purge.deleted",
      accountId: acc._id?.toString?.() || null,
      label,
      cleanup,
    }));
  }

  console.log(JSON.stringify({ event: "purge.done", dryRun, apply, matchedProcessed: processed, deleted }));
}

(() => {
  void (async () => {
    try {
      await main();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  })();
})();
