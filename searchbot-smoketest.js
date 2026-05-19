import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { Logger } from "telegram/extensions/Logger.js";

const SEARCH_BOT = process.env.SEARCH_BOT_USERNAME || "en_SearchBot";

const SESSION_STRING =
  "PASTE_YOUR_STRING_SESSION_HERE";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isValidBotResultMessage(msg) {
  if (!msg || msg.out || msg.action) return false;
  const rows = msg.replyMarkup?.rows;
  if (!rows?.length) return false;
  return rows
    .flatMap((r) => r.buttons)
    .some((btn) => btn.data?.toString("utf8").startsWith("filter|"));
}

function pickLatestResultMessage(msgs = []) {
  return (msgs || []).find(isValidBotResultMessage) || null;
}

function fingerprint(msg) {
  const text = (msg?.message || "").toString();
  const ents = Array.isArray(msg?.entities)
    ? msg.entities
        .map((e) => `${e.className || ""}:${e.offset || 0}:${e.length || 0}:${e.url || ""}`)
        .join("|")
    : "";
  const rows =
    msg?.replyMarkup?.rows
      ?.map((r) =>
        (r.buttons || [])
          .map((b) => `${b.text || ""}:${b.data ? b.data.toString("utf8") : ""}`)
          .join(",")
      )
      .join("|") || "";
  return `${msg?.id || ""}::${text}::${ents}::${rows}`;
}

function extractTmeLinks(msg) {
  const links = [];
  const text = msg?.message || "";
  for (const ent of msg?.entities || []) {
    const url =
      ent?.url ||
      (ent?.className === "MessageEntityUrl"
        ? text.slice(ent.offset, ent.offset + ent.length)
        : null);
    if (url && url.includes("t.me/")) links.push(url);
  }
  return links;
}

async function ensureStarted(client, botPeer) {
  const history = await client.getMessages(botPeer, { limit: 1 }).catch(() => []);
  if (!history.length) {
    await client.sendMessage(botPeer, { message: "/start" });
    await sleep(1500);
  }
}

async function clickAndWaitForUpdate(client, botPeer, msgId, btn, previousFp) {
  await client.invoke(
    new Api.messages.GetBotCallbackAnswer({
      peer: botPeer,
      msgId,
      data: btn.data,
    })
  );

  const backoffs = [3500, 6500, 12000, 22000];
  for (const waitMs of backoffs) {
    await sleep(waitMs);
    const byId = await client.getMessages(botPeer, { ids: [msgId] }).catch(() => null);
    const updated = Array.isArray(byId) ? byId[0] : byId;
    if (updated && isValidBotResultMessage(updated)) {
      const fp = fingerprint(updated);
      if (fp !== previousFp) return updated;
    }
  }
  return null;
}

async function runOnce(keywords) {
  const apiId = Number(process.env.API_ID || 0);
  const apiHash = process.env.API_HASH || "";
  if (!apiId || !apiHash) throw new Error("Missing API_ID/API_HASH in env.");
  if (!SESSION_STRING || SESSION_STRING.includes("PASTE_YOUR_STRING_SESSION_HERE")) {
    throw new Error("Paste a valid StringSession into SESSION_STRING in searchbot-smoketest.js");
  }

  const baseLogger = new Logger("none");
  const client = new TelegramClient(new StringSession(SESSION_STRING), apiId, apiHash, {
    connectionRetries: 3,
    requestRetries: 2,
    baseLogger,
  });

  await client.connect();
  try {
    const botPeer = await client.getEntity(SEARCH_BOT);
    await ensureStarted(client, botPeer);

    for (const keyword of keywords) {
      console.log(`\n=== keyword: ${keyword} ===`);
      await client.sendMessage(botPeer, { message: keyword });
      await sleep(2500);

      const msgs = await client.getMessages(botPeer, { limit: 10 });
      let reply = pickLatestResultMessage(msgs);
      if (!reply) {
        const latestText = (msgs || []).find(
          (m) => m && !m.out && !m.action && (m.message || "").toString().trim()
        );
        const t = (latestText?.message || "").toString();
        console.log(`no_result_message: ${t.slice(0, 200)}`);
        continue;
      }

      const buttons = reply.replyMarkup?.rows?.flatMap((r) => r.buttons) || [];
      const groupsBtn = buttons.find((b) => (b.text || "").includes("👥"));
      if (!groupsBtn) {
        console.log("no_groups_button");
        continue;
      }

      const fp0 = fingerprint(reply);
      const afterGroups = await clickAndWaitForUpdate(client, botPeer, reply.id, groupsBtn, fp0);
      if (!afterGroups) {
        console.log("groups_click_no_update");
        continue;
      }
      reply = afterGroups;

      let page = 1;
      while (true) {
        const links = extractTmeLinks(reply);
        console.log(`page ${page}: seen ${links.length}`);
        for (const l of links) console.log(`  ${l}`);

        const pageBtns = reply.replyMarkup?.rows?.flatMap((r) => r.buttons) || [];
        const nextBtn = pageBtns.find(
          (b) => (b.text || "").includes("➡️") || /next/i.test((b.text || "").toString())
        );
        if (!nextBtn) break;

        const fp = fingerprint(reply);
        const afterNext = await clickAndWaitForUpdate(client, botPeer, reply.id, nextBtn, fp);
        if (!afterNext) {
          console.log("next_click_no_update");
          break;
        }
        reply = afterNext;
        page += 1;
        await sleep(1500);
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}

(() => {
  void (async () => {
    try {
      await runOnce(["developer", "frontend developer", "backend developer"]);
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  })();
})();
