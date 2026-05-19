[OPEN] Debug Session: listener-missing-messages

## Symptom
- Listener accounts sometimes do not enqueue/log incoming messages from groups they are supposedly in.
- As a result, no LLM classification happens and no job posts get forwarded.
- Also observed: “preacher” activity not visible after startup.

## Expected
- When a message is posted in any group a listener account has joined, it should be captured by the MTProto event handler, enqueued, and later classified/posted.
- Preachers should rotate templates and post when they have templates + groups and posting is enabled.

## Hypotheses (falsifiable)
1) Listener event handler receives the update, but it is dropped by filters (`message.out`, `event.isGroup`, `event.isPrivate`, empty `text`) → would show handler events with drop-reason counters.
2) Listener account is not actually in the group (DB says joined, Telegram session isn’t in it) → would show missing dialog/entity resolution for that chatId.
3) Updates are not being received reliably because the client isn’t “primed” (missing updates state / dialogs warmup) or client is reconnecting silently → would show connection/update state changes and long idle windows despite activity.
4) Duplicate-listener overlap or dedupe logic removes one listener from the group, leaving the “wrong” listener active → would show dedupe leave events correlated with missing captures.
5) Preachers are running but gated (no templates/groups, botPostingEnabled off, slowmode, write-forbidden) → would show canPreach=false or repeated send failures.

## Evidence to collect (runtime logs)
- Listener NewMessage handler: event flags, drop reason, chatId/messageId, text length.
- Queue enqueue + batch claim + LLM request/response + post attempts.
- Client connectivity state / reconnects / idle time.
- Preacher loop: canPreach + group count + template count.

## Repro steps
1) Enable trace: set LISTENER_TRACE=1 (existing console trace) and enable Debug Server URL env (TRAEd).
2) Start server and bot.
3) Post a plain text message “Hiring: need a React dev” in a group a listener is already in.
4) Compare: did we see handler event → enqueue → batch → decision → post.attempt?

## Status
- Evidence collected:
  - Captures work: `listener.new_message` → `queue.enqueue` → `ai.batch` → `llm.response` → `post.attempt`.
  - Found duplication risk: same text appeared twice in a batch with different ids, and `chatId` appeared in different forms (e.g. `-100...` vs `-...`), which can bypass the `(chatId,messageId)` unique key.
  - Found missing “Source Group”: for `chatId` like `-520...` the group link builder returned null.

- Fixes applied:
  - Canonicalize chatId for queue uniqueness (`tg:<internalId>`), to prevent duplicate enqueues/posts for the same source message.
  - Add keepalive + warmup (GetState + getDialogs) for more stable listener updates.
  - Add `Group ID` when Source Group is missing or is a `t.me/c/...` link.

- Next: user verify no duplicate bot posts for a single source message.
