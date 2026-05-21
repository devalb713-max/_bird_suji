# Sujini Codebase Handoff (Implementation Notes)

This document is a technical handoff for ongoing maintenance. It explains key design decisions added recently, where the logic lives, and how to debug it.

## Core Concepts

### Accounts + Roles

All user sessions live in `Account` documents (`models/db.js`).

- `listener`: joins groups and listens for new messages, then enqueues content for classification + posting.
- `preacher`: joins groups and posts templates in a loop.
- `finder`: talks to the SearchBot and stores `GroupLink` records.
- `inviter`: admin/fallback account for creating invite links and privileged ops. It is intentionally excluded from worker-account uniqueness constraints.

### Group links vs real membership

- `GroupLink` collection is a pool of discovered join links (`status: new|claimed|joined|dead`).
- `Account.groups[]` is the system’s notion of “this account is in these groups”.
- To keep `Account.groups[]` accurate, worker accounts (listener/preacher) periodically sync their Telegram dialogs and overwrite `Account.groups[]`.

## Uniqueness Rules (Listener/Preacher)

### Goal

No two worker accounts (listener/preacher) should share the same non-approved group.

Approved bot groups are exempt:
- any number of accounts can join them, BUT
- preachers must not post there.

### Where it’s enforced

1) Join-time check (group joiner)
- File: `helpers/groupJoiner.js`
- Function: `isGroupTakenByListenerOrPreacher(...)`
- Behavior:
  - loads approved group exemptions from:
    - `ApprovedChat` (type=group, `chatId`)
    - `BotSettings.requiredGroupId`
    - optional `inviteLink` fields when available
  - if target group is approved → not considered taken
  - otherwise does a single Mongo existence query across listener+preacher accounts using:
    - `groups.normalizedLink`
    - `groups.link`
    - (when resolvable) `groups.id`

2) Preacher-side pruning
- File: `helpers/messenger.js`
- Function: `prunePreacherOverlaps(...)`
- Behavior:
  - removes preacher from groups taken by other worker accounts
  - skips removal for approved bot groups

3) One-time cleanup script
- File: `dedupe-cross-role-groups.js`
- Behavior:
  - syncs groups from Telegram dialogs for all listener+preacher accounts
  - detects overlaps (excluding approved bot groups)
  - keeps one “winner” (prefers listener if present), makes the others leave
  - prints JSON lines for evidence: `dedupe.overlap`, `dedupe.leave`, and `dedupe.done`

## Approved (Authorized) Groups

Approved groups are managed via the bot admin UI (Authorized Groups/Channels), backed by the `ApprovedChat` collection (`models/db.js`).

Notes:
- `/approve` now attempts to store a public `https://t.me/<username>` link into `ApprovedChat.inviteLink` when the group has a username. This helps link-based checks.
- For private groups without username, the canonical identifier is `ApprovedChat.chatId` + `BotSettings.requiredGroupId`.

## Account Group Sync (Worker Accounts)

### Why it exists

Without syncing, `Account.groups[]` drifts (manual leaves, kicked, invalid stored links), and uniqueness checks become unreliable.

### Where it runs

- Sync function: `helpers/groupJoiner.js` → `syncListenerAndPreacherGroupsOnce()`
- Scheduler: `workers/joinWorker.js` poller (`ACCOUNT_GROUPS_SYNC_INTERVAL_MS`, default 5 minutes)

It only targets `role in ['listener','preacher']` (inviter/finder excluded).

### Data stored

In `models/db.js`:
- `Account.groups[]` items now include `normalizedLink`
- `Account.groupsSyncedAt`, `Account.groupsSyncError`

Indexes exist for faster matching:
- `{ role: 1, 'groups.normalizedLink': 1 }`
- `{ role: 1, 'groups.id': 1 }`

## Preacher Join Cycle (“grand cycle”) Reliability

Preacher logic lives in `helpers/messenger.js`:

- It posts templates through its group list.
- After finishing a cycle, it tries to join a batch of new groups from `GroupLink`.

Important fixes:
- Preacher join now checks “taken” against both listeners + preachers (not just other preachers).
- Stale `GroupLink` claims are periodically released back to `new` (to avoid “stuck claimed” starving joiners).

## Listener Reliability at Scale (MTProto Updates)

Symptoms observed:
- listeners worked in small test groups but not in many real “developer groups”
- listeners appear to “go off” after a while

Fixes applied in `helpers/messenger.js`:
- Treat “groupish” updates as `event.isGroup || event.isChannel` (supergroups often show up as `isChannel` with `megagroup=true`)
- Keepalive loop:
  - `client.getMe()`
  - `Api.updates.GetState`
  - `Api.account.UpdateStatus({ offline:false })`
  - periodic `client.getDialogs(...)` warm-up (default every 60s)
- Reconnect watchdog if no events for too long (default 12m): disconnect/reconnect, then warm-up again.

Client defaults also adjusted in `helpers/telegram.js`:
- `autoReconnect: true`, retry delay, and a timeout.

Relevant upstream behavior: GramJS users report updates can stop unless “high level requests” occur, and `getDialogs` on an interval is a practical workaround.

## Group Count Milestone Announcements

In `bot/handlers.js`:
- `announceListenerGroupsProgress(telegram)` computes the total unique groups across all accounts except inviters.
- Every 30 minutes it runs; it posts only when `count >= lastCount + 40`.
- Targets:
  - `requiredChannelId` and `requiredGroupId` (both if set), else `jobsTargetChatId`
- State stored in `BotSettings`:
  - `listenerGroupsAnnouncedCount`, `listenerGroupsAnnouncedAt`

## AI Hiring-Intent Classification (OpenAI → OpenRouter)

The listener pipeline only posts messages that pass an LLM-based “hiring intent” classifier.

Where it runs:
- File: `helpers/messenger.js`
- Functions: `classifyHiringIntentBatch(...)` and `processAiBatchOnce()`

Provider order + behavior:
- OpenAI is attempted first.
- If OpenAI fails, OpenRouter is attempted as fallback.
- If both providers fail, there is no keyword/regex fallback. The batch errors out, `aiConsecutiveFails` increments, and admins get alerted after repeated failures.

OpenRouter retries + failover:
- Uses `OPENROUTER_API_KEY_1` then `OPENROUTER_API_KEY_2` (legacy `OPENROUTER_API_KEY` is also accepted).
- Per key: up to 3 retries (for 429/5xx/timeouts/parse errors), then it rotates to the next key.
- Config: `OPENROUTER_TIMEOUT_MS` (default 25000).

Safety default:
- If the model response does not include a decision for a queued message id, it defaults to `keep=false` (do not post).

Admin alerting:
- Stored in `BotSettings`: `aiConsecutiveFails`, `aiCreditsAlertedAt`, `aiAlertsEnabled`.
- After repeated failures, admins are notified that providers are failing / credits may be exhausted.

## Debugging Checklist

1) Are listener accounts receiving any events?
- Check `Account.listenerLastSeenAt`, `listenerLastError`.
- Enable debug server env to inspect `listener.new_message` events.

2) Are listeners dropping supergroup updates?
- Verify `dropReason` for events; “not_groupish” indicates the filter rejected it.

3) Are joiners stuck because links are “claimed” forever?
- Check `GroupLink` counts by `status`. If `claimed` is high and static, stale-release may not be running, or multiple processes are fighting.

4) Are uniqueness checks too aggressive?
- Confirm approved groups exist in `ApprovedChat` / `BotSettings.requiredGroupId`.
- Approved groups should never block joining for worker accounts.

## File Map

- `models/db.js`: mongoose schemas (`Account`, `GroupLink`, `ApprovedChat`, `BotSettings`, ...)
- `helpers/groupJoiner.js`: finder + generic joiner, worker-account uniqueness checks, group sync
- `helpers/messenger.js`: listener (NewMessage handler) + preacher (posting + join phase)
- `workers/joinWorker.js`: join worker + pollers (search-limit resume, dedupe, group sync)
- `bot/handlers.js`: bot UI (Authorized Groups/Channels), settings, announcements, membership enforcement
- `dedupe-cross-role-groups.js`: one-time overlap cleanup script (prints JSON evidence)
