import "dotenv/config";

import { Telegraf } from "telegraf";
import {
  connectDB,
  Account,
  Admin,
  Keyword,
  ApprovedChat,
  BotChat,
  BotSettings,
  BotUser,
  GroupLink,
  Payment,
} from "./models/db.js";
import { setupHandlers, seedOnStartup, startSchedulers } from "./bot/handlers.js";
import launchBot from "./bot/launchBot.js";
import { startJoinWorker } from "./workers/joinWorker.js";
import { startMessageWorker } from "./workers/messageWorker.js";
import express from "express";

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

app.get("/ping", (r, rs) => rs.send("Hello world"));

function escHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPage(title, body) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escHtml(title)}</title>
    <style>
      :root {
        --bg: #0b1020;
        --bg2: #090d1a;
        --card: rgba(255, 255, 255, 0.06);
        --card2: rgba(255, 255, 255, 0.04);
        --border: rgba(255, 255, 255, 0.10);
        --text: rgba(255, 255, 255, 0.92);
        --muted: rgba(255, 255, 255, 0.62);
        --link: #7aa8ff;
        --good: #39d98a;
        --bad: #ff5c5c;
        --shadow: 0 10px 35px rgba(0, 0, 0, 0.35);
      }

      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f6f8ff;
          --bg2: #eef2ff;
          --card: rgba(255, 255, 255, 0.78);
          --card2: rgba(255, 255, 255, 0.60);
          --border: rgba(18, 26, 46, 0.12);
          --text: rgba(18, 26, 46, 0.92);
          --muted: rgba(18, 26, 46, 0.62);
          --link: #1a4bff;
          --shadow: 0 10px 28px rgba(18, 26, 46, 0.10);
        }
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        color: var(--text);
        background: radial-gradient(1400px 700px at 15% 0%, rgba(122, 168, 255, 0.22) 0%, rgba(122, 168, 255, 0) 60%),
                    radial-gradient(1200px 700px at 85% 0%, rgba(57, 217, 138, 0.16) 0%, rgba(57, 217, 138, 0) 55%),
                    linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
      }

      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }

      .container { max-width: 1100px; margin: 0 auto; padding: 28px 16px 40px; }
      .topbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 18px 16px;
        background: linear-gradient(180deg, var(--card) 0%, var(--card2) 100%);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }
      .title { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
      .subtitle { margin-top: 6px; color: var(--muted); font-size: 13px; }
      .nav { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
        font-size: 13px;
        color: var(--text);
      }
      .chip:hover { background: rgba(255, 255, 255, 0.08); text-decoration: none; }

      h2 { margin: 18px 0 10px; font-size: 16px; letter-spacing: -0.01em; color: var(--text); }
      .section {
        margin-top: 16px;
        padding: 16px;
        background: linear-gradient(180deg, var(--card) 0%, var(--card2) 100%);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .stats-grid {
        display: grid;
        grid-template-columns: repeat(12, 1fr);
        gap: 10px;
      }
      .stat {
        grid-column: span 3;
        padding: 12px 12px 10px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.04);
      }
      .stat .k { color: var(--muted); font-size: 12px; }
      .stat .v { margin-top: 6px; font-size: 20px; letter-spacing: -0.02em; }
      .stat .hint { margin-top: 6px; color: var(--muted); font-size: 12px; }
      @media (max-width: 980px) { .stat { grid-column: span 4; } }
      @media (max-width: 720px) { .stat { grid-column: span 6; } }
      @media (max-width: 460px) { .stat { grid-column: span 12; } }

      .table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--border); }
      table { border-collapse: collapse; width: 100%; min-width: 620px; background: rgba(255, 255, 255, 0.02); }
      th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
      th { position: sticky; top: 0; background: rgba(0, 0, 0, 0.18); backdrop-filter: blur(8px); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
      tr:hover td { background: rgba(255, 255, 255, 0.04); }
      td.code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }

      .muted { color: var(--muted); font-size: 12px; }
      .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; }
      .pill.good { color: var(--good); }
      .pill.bad { color: var(--bad); }
      .footer { margin-top: 14px; color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="container">${body}</div>
  </body>
</html>`;
}

app.get("/", (req, res) => res.redirect("/stats"));

app.get("/stats", async (req, res) => {
  try {
    const now = new Date();
    const nowMs = Date.now();

    const [
      settings,
      usersTotal,
      usersBanned,
      usersPending,
      usersActiveTrial,
      usersActiveSub,
      admins,
      paymentsTotal,
      approvedChatsTotal,
      knownChatsTotal,
      accountsByRole,
      linksByStatus,
    ] = await Promise.all([
      BotSettings.findOne({}).lean(),
      BotUser.countDocuments({}),
      BotUser.countDocuments({ bannedAt: { $ne: null } }),
      BotUser.countDocuments({ pendingSubscriptionMonths: { $gt: 0 } }),
      BotUser.countDocuments({ trialEndsAt: { $gt: now } }),
      BotUser.countDocuments({ subscriptionEndsAt: { $gt: now } }),
      Admin.countDocuments({}),
      Payment.countDocuments({}),
      ApprovedChat.countDocuments({}),
      BotChat.countDocuments({ type: { $in: ["group", "supergroup"] } }),
      Account.aggregate([{ $group: { _id: "$role", c: { $sum: 1 } } }]),
      GroupLink.aggregate([{ $group: { _id: "$status", c: { $sum: 1 } } }]),
    ]);

    const accountMap = Object.fromEntries(accountsByRole.map((r) => [r._id, r.c]));
    const linkMap = Object.fromEntries(linksByStatus.map((r) => [r._id, r.c]));

    const testModeRaw = (process.env.TESTMODE || "").toString().trim().toLowerCase();
    const testMode =
      testModeRaw === "1" ||
      testModeRaw === "true" ||
      testModeRaw === "yes" ||
      testModeRaw === "on";

    const body = `
      <div class="topbar">
        <div>
          <h1 class="title">Sujini Stats</h1>
          <div class="subtitle">Server time: ${escHtml(new Date(nowMs).toISOString())}</div>
        </div>
        <div class="nav">
          <a class="chip" href="/stats">Overview</a>
          <a class="chip" href="/stats/users">Users</a>
          <a class="chip" href="/stats/payments">Payments</a>
          <a class="chip" href="/stats/chats">Chats</a>
        </div>
      </div>

      <div class="section">
        <h2>Overview</h2>
        <div class="stats-grid">
          <div class="stat"><div class="k">Users</div><div class="v">${usersTotal}</div><div class="hint">total</div></div>
          <div class="stat"><div class="k">Active trial</div><div class="v">${usersActiveTrial}</div><div class="hint">trialEndsAt &gt; now</div></div>
          <div class="stat"><div class="k">Active subscription</div><div class="v">${usersActiveSub}</div><div class="hint">subscriptionEndsAt &gt; now</div></div>
          <div class="stat"><div class="k">Pending activation</div><div class="v">${usersPending}</div><div class="hint">paid, not activated</div></div>
          <div class="stat"><div class="k">Banned users</div><div class="v">${usersBanned}</div><div class="hint">blocked from bot</div></div>
          <div class="stat"><div class="k">Admins</div><div class="v">${admins}</div><div class="hint">bot admins</div></div>
          <div class="stat"><div class="k">Payment records</div><div class="v">${paymentsTotal}</div><div class="hint">historical</div></div>
          <div class="stat"><div class="k">Approved groups</div><div class="v">${approvedChatsTotal}</div><div class="hint">mandatory + target</div></div>
          <div class="stat"><div class="k">Known groups</div><div class="v">${knownChatsTotal}</div><div class="hint">bot is in</div></div>
          <div class="stat"><div class="k">Test mode</div><div class="v">${testMode ? `<span class="pill good">ON</span>` : `<span class="pill bad">OFF</span>`}</div><div class="hint">billing timers</div></div>
        </div>
        <div class="footer">Open endpoints: <a href="/ping">/ping</a> · <a href="/stats">/stats</a></div>
      </div>

      <div class="section">
        <h2>Accounts</h2>
        <div class="table-wrap">
          <table>
            <tr><th>Role</th><th>Count</th></tr>
            <tr><td>listener</td><td>${accountMap.listener || 0}</td></tr>
            <tr><td>preacher</td><td>${accountMap.preacher || 0}</td></tr>
            <tr><td>finder</td><td>${accountMap.finder || 0}</td></tr>
            <tr><td>inviter</td><td>${accountMap.inviter || 0}</td></tr>
          </table>
        </div>
      </div>

      <div class="section">
        <h2>Group Links</h2>
        <div class="table-wrap">
          <table>
            <tr><th>Status</th><th>Count</th></tr>
            <tr><td>new</td><td>${linkMap.new || 0}</td></tr>
            <tr><td>claimed</td><td>${linkMap.claimed || 0}</td></tr>
            <tr><td>joined</td><td>${linkMap.joined || 0}</td></tr>
            <tr><td>dead</td><td>${linkMap.dead || 0}</td></tr>
          </table>
        </div>
      </div>

      <div class="section">
        <h2>Settings</h2>
        <div class="table-wrap">
          <table>
            <tr><th>Key</th><th>Value</th></tr>
            <tr><td>requiredChannelId</td><td class="code">${escHtml(settings?.requiredChannelId || "")}</td></tr>
            <tr><td>inviterAccountId</td><td class="code">${escHtml(settings?.inviterAccountId || "")}</td></tr>
            <tr><td>inviterAccountIds</td><td class="code">${escHtml((settings?.inviterAccountIds || []).join(", "))}</td></tr>
            <tr><td>botPostingEnabled</td><td>${settings?.botPostingEnabled ? `<span class="pill good">true</span>` : `<span class="pill bad">false</span>`}</td></tr>
          </table>
        </div>
      </div>
    `;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderPage("Sujini Stats", body));
  } catch (err) {
    res.status(500).send("Failed to load stats.");
  }
});

app.get("/stats/users", async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || "50", 10) || 50));
    const skip = page * limit;

    const [total, users] = await Promise.all([
      BotUser.countDocuments({}),
      BotUser.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const rows = users
      .map(
        (u) => `<tr>
          <td class="code">${escHtml(u.userId)}</td>
          <td>${escHtml(u.username || "")}</td>
          <td>${escHtml(u.bannedAt ? new Date(u.bannedAt).toISOString() : "")}</td>
          <td>${escHtml(u.trialEndsAt ? new Date(u.trialEndsAt).toISOString() : "")}</td>
          <td>${escHtml(u.subscriptionEndsAt ? new Date(u.subscriptionEndsAt).toISOString() : "")}</td>
          <td>${escHtml((u.pendingSubscriptionMonths || 0).toString())}</td>
          <td>${escHtml(u.removedAt ? new Date(u.removedAt).toISOString() : "")}</td>
        </tr>`
      )
      .join("");

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const nav = `
      <p>
        <a href="/stats/users?page=${Math.max(0, page - 1)}&limit=${limit}">Prev</a> ·
        <a href="/stats/users?page=${Math.min(totalPages - 1, page + 1)}&limit=${limit}">Next</a>
        <span class="muted"> (page ${page + 1}/${totalPages}, total ${total})</span>
      </p>`;

    const body = `
      <div class="topbar">
        <div>
          <h1 class="title">Users</h1>
          <div class="subtitle">page ${page + 1}/${Math.max(1, Math.ceil(total / limit))} · total ${total}</div>
        </div>
        <div class="nav">
          <a class="chip" href="/stats">Overview</a>
          <a class="chip" href="/stats/users">Users</a>
          <a class="chip" href="/stats/payments">Payments</a>
          <a class="chip" href="/stats/chats">Chats</a>
        </div>
      </div>
      <div class="section">
        ${nav}
        <div class="table-wrap">
          <table>
            <tr>
              <th>User ID</th>
              <th>Username</th>
              <th>Banned At</th>
              <th>Trial Ends</th>
              <th>Subscription Ends</th>
              <th>Pending Months</th>
              <th>Removed At</th>
            </tr>
            ${rows}
          </table>
        </div>
        ${nav}
      </div>
    `;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderPage("Users", body));
  } catch {
    res.status(500).send("Failed to load users.");
  }
});

app.get("/stats/payments", async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || "50", 10) || 50));
    const skip = page * limit;

    const [total, payments] = await Promise.all([
      Payment.countDocuments({}),
      Payment.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const rows = payments
      .map(
        (p) => `<tr>
          <td>${escHtml(p.createdAt ? new Date(p.createdAt).toISOString() : "")}</td>
          <td class="code">${escHtml(p.userId)}</td>
          <td>${escHtml(p.username || "")}</td>
          <td>${escHtml(p.kind || "")}</td>
          <td>${escHtml(p.currency || "")}</td>
          <td>${escHtml(String(p.totalAmount || 0))}</td>
          <td>${escHtml(String(p.months || 0))}</td>
        </tr>`
      )
      .join("");

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const nav = `
      <p>
        <a href="/stats/payments?page=${Math.max(0, page - 1)}&limit=${limit}">Prev</a> ·
        <a href="/stats/payments?page=${Math.min(totalPages - 1, page + 1)}&limit=${limit}">Next</a>
        <span class="muted"> (page ${page + 1}/${totalPages}, total ${total})</span>
      </p>`;

    const body = `
      <div class="topbar">
        <div>
          <h1 class="title">Payments</h1>
          <div class="subtitle">page ${page + 1}/${Math.max(1, Math.ceil(total / limit))} · total ${total}</div>
        </div>
        <div class="nav">
          <a class="chip" href="/stats">Overview</a>
          <a class="chip" href="/stats/users">Users</a>
          <a class="chip" href="/stats/payments">Payments</a>
          <a class="chip" href="/stats/chats">Chats</a>
        </div>
      </div>
      <div class="section">
        ${nav}
        <div class="table-wrap">
          <table>
            <tr>
              <th>Created</th>
              <th>User ID</th>
              <th>Username</th>
              <th>Kind</th>
              <th>Currency</th>
              <th>Total Amount</th>
              <th>Months</th>
            </tr>
            ${rows}
          </table>
        </div>
        ${nav}
      </div>
    `;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderPage("Payments", body));
  } catch {
    res.status(500).send("Failed to load payments.");
  }
});

app.get("/stats/chats", async (req, res) => {
  try {
    const [approved, chats] = await Promise.all([
      ApprovedChat.find({}).lean(),
      BotChat.find({ type: { $in: ["group", "supergroup"] } }).sort({ updatedAt: -1 }).limit(500).lean(),
    ]);
    const approvedSet = new Set(approved.map((a) => a.chatId));

    const rows = chats
      .map(
        (c) => `<tr>
          <td>${approvedSet.has(c.chatId) ? "✅" : "⛔"}</td>
          <td>${escHtml(c.title || "")}</td>
          <td class="code">${escHtml(c.chatId || "")}</td>
          <td>${escHtml(c.type || "")}</td>
          <td>${escHtml(c.username ? "@" + c.username.replace(/^@/, "") : "")}</td>
          <td>${escHtml(c.updatedAt ? new Date(c.updatedAt).toISOString() : "")}</td>
        </tr>`
      )
      .join("");

    const body = `
      <div class="topbar">
        <div>
          <h1 class="title">Chats</h1>
          <div class="subtitle">Shows up to 500 most recently updated chats.</div>
        </div>
        <div class="nav">
          <a class="chip" href="/stats">Overview</a>
          <a class="chip" href="/stats/users">Users</a>
          <a class="chip" href="/stats/payments">Payments</a>
          <a class="chip" href="/stats/chats">Chats</a>
        </div>
      </div>
      <div class="section">
        <div class="table-wrap">
          <table>
            <tr>
              <th>Approved</th>
              <th>Title</th>
              <th>Chat ID</th>
              <th>Type</th>
              <th>Username</th>
              <th>Updated</th>
            </tr>
            ${rows}
          </table>
        </div>
      </div>
    `;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderPage("Chats", body));
  } catch {
    res.status(500).send("Failed to load chats.");
  }
});

const PORT = Number(process.env.port || process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Sujini server listening on port ${PORT}`);
});

async function connectWithRetry() {
  while (true) {
    try {
      await connectDB();
      return;
    } catch (err) {
      console.error(
        `MongoDB connection failed: ${err.message} — retrying in 10s`,
      );
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

await connectWithRetry();

async function resumeWorkersOnBoot() {
  const settings = (await BotSettings.findOne({})) || (await BotSettings.create({}));
  if (!settings?.autoResumeWorkers) return;

  const accounts = await Account.find({ session: { $nin: [null, ""] } }, "_id role isJoining isMessaging").lean();
  for (const acc of accounts) {
    if (acc.role === "inviter") continue;
    if (acc.isJoining) await startJoinWorker(acc._id.toString()).catch(() => {});
    if (acc.isMessaging) await startMessageWorker(acc._id.toString()).catch(() => {});
  }
}

await seedOnStartup();
setupHandlers(bot);
launchBot(bot);
startSchedulers(bot.telegram);
await resumeWorkersOnBoot();
