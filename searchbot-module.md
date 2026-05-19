# SearchBot Group-Link Harvester (Generic Module)

This document describes a generic “SearchBot harvester” that:

- Consumes keyword strings (input)
- Talks to a Telegram search bot (e.g., `en_SearchBot`) over MTProto (GramJS)
- Pages through results by clicking inline buttons
- Extracts `t.me/...` links from the bot’s result message
- Emits discovered group/channel links to your system (output)

The logic is independent of any “account roles” system. You can embed it inside any scheduler/worker system.

## Inputs / Outputs

**Keyword input**

You provide keywords as an iterable source (array, DB cursor, queue, etc.). The module consumes one keyword at a time.

In this repo, keyword input is consumed in [groupJoiner.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/fomativeh/mega-forwarder/helpers/groupJoiner.js) via `claimNextKeyword(...)` and then sent to the SearchBot in `runGroupFinder(...)`.

**Link output**

The module emits links per page. Integrate this as:

- `onLinks(keyword, pageNum, links)` callback, or
- push into a queue, or
- write to a DB table.

In this repo, the output sink is `storeDiscoveredLinks(...)` in [groupJoiner.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/fomativeh/mega-forwarder/helpers/groupJoiner.js) which inserts into the `GroupLink` Mongo collection.

## Integration Surface (Minimal)

If you want to adopt the core logic in any system, structure it around two integration points:

- `getNextKeyword()` → supplies the next keyword string
- `onLinks({ keyword, pageNum, links })` → receives extracted `t.me/...` links per page

Skeleton:

```js
async function runHarvesterLoop({ getNextKeyword, onLinks, runSingleKeyword }) {
  while (true) {
    const keyword = await getNextKeyword();
    if (!keyword) return;
    await runSingleKeyword(keyword, async ({ pageNum, links }) => {
      await onLinks({ keyword, pageNum, links });
    });
  }
}
```

## Core Flow

### 1) (Optional) bootstrap `/start`

Some bots require `/start` once per chat history. You should do:

- If there is no prior chat history with the bot: send `/start` once.
- Otherwise: do not spam `/start` every keyword.

Pseudocode:

```js
async function ensureStarted(client, botPeer) {
  const history = await client.getMessages(botPeer, { limit: 1 }).catch(() => []);
  if (!history.length) {
    await client.sendMessage(botPeer, { message: "/start" });
  }
}
```

### 2) Send keyword

Send one keyword text message to the bot peer:

```js
await client.sendMessage(botPeer, { message: keyword });
```

Then fetch a small window of recent messages to find the result message:

```js
const msgs = await client.getMessages(botPeer, { limit: 10 });
```

### 3) Detect bot states (limit / no-results / results)

You should treat three cases specially:

- **Daily limit reached**: stop this session for this account.
- **No results**: move to next keyword immediately.
- **Result message**: proceed to filter + paging.

The reliable way to detect the “result message” is to look for inline buttons whose callback `data` looks like a stable marker.

In this repo, the SearchBot results are detected by the presence of callback data starting with `filter|`:

```js
function isValidBotResultMessage(msg) {
  const rows = msg.replyMarkup?.rows;
  return rows?.flatMap(r => r.buttons).some(btn => btn.data?.toString("utf8").startsWith("filter|"));
}
```

### 4) Click the “Groups” filter button

Many search bots show result categories (👥 groups, 📢 channels, etc.) as inline buttons. You must click “Groups” to switch the result set to groups.

Pseudocode:

```js
const groupsBtn = buttons.find(b => (b.text || "").includes("👥"));
await client.invoke(new Api.messages.GetBotCallbackAnswer({
  peer: botPeer,
  msgId: resultMsg.id,
  data: groupsBtn.data,
}));
```

### 5) Extract links from the updated results message (page 1)

Telegram bots typically return links inside message entities:

- `MessageEntityTextUrl` → `ent.url`
- `MessageEntityUrl` → the URL is in the raw text slice at `(offset, length)`

Pseudocode:

```js
function extractTmeLinks(msg) {
  const links = [];
  const text = msg.message || "";
  for (const ent of msg.entities || []) {
    const url = ent.url || (ent.className === "MessageEntityUrl" ? text.slice(ent.offset, ent.offset + ent.length) : null);
    if (url && url.includes("t.me/")) links.push(url);
  }
  return links;
}
```

### 6) Click “Next” repeatedly until end-of-pages

Most search bots use one message that gets updated/edited as you page. So you cannot assume a new message will appear after clicking “Next”.

The robust pattern is:

1. Click the button
2. Fetch the same `msgId` again
3. Detect whether it changed (fingerprint)

Pseudocode:

```js
function fingerprint(msg) {
  const text = (msg.message || "").toString();
  const ents = (msg.entities || []).map(e => `${e.className}:${e.offset}:${e.length}:${e.url || ""}`).join("|");
  const rows = msg.replyMarkup?.rows?.map(r => (r.buttons || []).map(b => `${b.text}:${b.data ? b.data.toString("utf8") : ""}`).join(",")).join("|") || "";
  return `${msg.id}::${text}::${ents}::${rows}`;
}

async function clickAndWaitForUpdate(client, botPeer, msgId, btn, previousFp) {
  await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: botPeer, msgId, data: btn.data }));
  await sleep(4000);
  const updated = await client.getMessages(botPeer, { ids: [msgId] });
  if (updated && fingerprint(updated[0]) !== previousFp) return updated[0];
  return null;
}
```

End-of-pages condition:

- If there is no `➡️` / “Next” button on the current page → stop paging → move to the next keyword.

## Keyword Allocation (Avoid Parallel Duplication)

If you run multiple harvester workers concurrently, you should avoid them processing the same keyword set at the same time.

Generic approach:

- Maintain a keyword pool store with:
  - `assignedToWorkerId`
  - `assignedOrder`
  - `lastProcessedAt`
  - a lock (`lockedAt`, `lockExpiresAt`)
- Rebalance keywords across active workers periodically (round-robin).
- Each worker pulls from its own pool in a stable sequential order (`lastProcessedAt` then `assignedOrder`).

In this repo, that assignment and sequential selection is implemented in [groupJoiner.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/fomativeh/mega-forwarder/helpers/groupJoiner.js) using `assignedToAccountId`, `assignedOrder`, and `lastProcessedAt`.

## Error Handling Principles

You should implement all of these:

- **Flood waits**: if Telegram returns `FLOOD_WAIT_X`, sleep for X seconds and resume.
- **Timeouts**: treat as transient; retry the click or refetch message state a few times.
- **Auth errors** (session invalid): stop this worker and mark the account unusable until re-login.
- **Bot daily limit**: stop for the day and schedule retry after reset.

## Minimal Smoke Test Script

This repo includes a standalone smoke test that runs the above flow with a hardcoded session placeholder:

- [searchbot-smoketest.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/fomativeh/mega-forwarder/searchbot-smoketest.js)

It prints extracted links to stdout and does not require MongoDB.
