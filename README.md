## Sujini (Telegram)

This project is a Telegram platform for developers where:

- Group-finder Telegram accounts discover developer groups using `en_SearchBot` + keywords and store group links in MongoDB.
- Listener Telegram accounts join discovered groups and listen for job/hiring messages.
- Preacher Telegram accounts join discovered groups and post admin-provided templates (optionally with a logo), continuously.
- The bot enforces community access: 3-day trial, then 30-day subscription via **100 Sujicards** or **100 Stars**.

### Roles

- **Inviter** (`role=inviter`)
  - Logged-in Telegram account used to generate invite links for the required channel/group and admin ops fallback (when the bot lacks rights).
  - Exempt from group uniqueness rules and group-sync (doesn’t participate in harvesting/listening/preaching).
- **Group Finder** (`role=finder`)
  - Searches for groups using keywords from the bot’s Keywords menu.
  - Stores discovered `t.me` links in `GroupLink` records.
  - Stops when the search bot indicates a daily limit; resumes after a rest window.
- **Listener** (`role=listener`)
  - Joins groups from the stored `GroupLink` pool until ~500 groups per account.
  - Listens to messages in groups and classifies “job/hiring intent”.
  - If a message qualifies, formats it and posts it to the configured Jobs Target chat (or a fallback set of approved groups).
  - Enforces “no two worker accounts in the same group” (no listener/preacher overlap), except bot-approved groups.
  - Uses keepalive + dialogs warm-up to keep MTProto updates reliable at scale.
- **Preacher** (`role=preacher`)
  - Joins groups from the stored `GroupLink` pool until ~500 groups per account.
  - Posts message templates in an endless cycle.
  - Skips a group if its own message exists within the last 30 messages.
  - Leaves groups where posting is forbidden (group-level restrictions).
  - Enforces “no two worker accounts in the same group” (no listener/preacher overlap), except bot-approved groups.
  - Never posts into bot-approved groups (those are treated as operational/whitelisted groups).

### Group membership + uniqueness rules

- **Approved (authorized) bot groups are exempt**: any number of accounts can join them, but preachers must not post there.
- **Every other group is exclusive across listeners and preachers**: before joining a group link, the account checks MongoDB to see if any listener/preacher is already in it; if yes, it skips that link.
- A periodic **account-group sync** refreshes `Account.groups` from Telegram dialogs so DB membership stays accurate even after manual leaves/joins.

### Setup

Environment variables (see `.env.example`):

- `BOT_TOKEN`
- `MONGODB_URI`
- `BOT_ADMIN_ID` (bootstrap first admin user id)
- `API_ID`, `API_HASH` (required for Telegram account login via the admin panel)
- `SEARCH_BOT_USERNAME` (default `en_SearchBot`)
- Listener + AI pipeline
  - `AI_BATCH_INTERVAL_MS` (how often the job-classification/posting batch runs)
- Group sync + dedupe
  - `ACCOUNT_GROUPS_SYNC_INTERVAL_MS` (default 5m)
  - `LISTENER_DEDUPE_INTERVAL_MS` (default 5m)
  - `LISTENER_DEDUPE_MAX_LEAVES` (default 8)
- Listener reliability (MTProto keepalive)
  - `LISTENER_KEEPALIVE_MS` (default 60s)
  - `LISTENER_DIALOGS_WARM_MS` (default 60s)
  - `LISTENER_RECONNECT_IDLE_MS` (default 12m)
- AI classification (optional)
  - `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`)
  - `OPENROUTER_API_KEY_1`, `OPENROUTER_API_KEY_2` (failover keys), `OPENROUTER_MODEL` (default `meta-llama/llama-3.1-8b-instruct:free`)
  - `OPENROUTER_TIMEOUT_MS` (default 25000)

AI prompt rules are stored in `prompt.txt`.
- Single-message classifier returns `true`/`false`.
- Batch classifier returns JSON: `[{ "id": "...", "keep": true|false }]`.

Run:

```bash
npm install
npm start
```

The bot uses **long polling** for updates. Listener/Preacher/Finder roles use **MTProto user sessions** (GramJS).

### Bot admin panel

- **Accounts**
  - Add Telegram accounts and choose a role (Listener / Preacher / Group Finder / Inviter) before login.
  - Start/stop Join/Search and Listen/Preach loops per account (workers do not auto-start on boot).
- **Templates**
  - Add/delete templates (admin-only). Preachers randomly pick from these.
- **Keywords**
  - Add/delete keywords used by group-finder accounts for searching.
- **Group Links**
  - View counts (new/claimed/joined/dead), reset claimed links, delete dead links.
- **Settings**
  - Set Required Channel, Required Group, Jobs Target
  - Set Inviter Account (must be admin in required chats)
  - Toggle bot posting (queues while disabled, flushes on enable)
  - Toggle AI alerts (admin notifications after repeated AI failures)
  - Joined-groups milestone announcements (posts when total unique groups increases by 40+)

### Community access enforcement

- Users must `/start` the bot to create a DB record and begin the 3-day trial.
- Trial/subscription expiry triggers removal from the required group/channel (kick-style). If Telegram requires a ban, unban is attempted immediately or scheduled shortly after.
- Paid membership is **100 Sujicards** or **100 Stars** per 30 days, with reminders during trial (8h/2h) and before subscription expiry (3 days).
- Payments are activated only after the user is in the required chats. Payment confirm flows are guarded against double-taps.
- New users get a short onboarding grace window after join links are issued, to avoid being removed mid-join.

### Scripts

```bash
node seed.js
node seed-templates.js
node rename-accounts.js
node dedupe-cross-role-groups.js
```
