## Sujini (Telegram)

This project is a Telegram platform for developers where:

- Group-finder Telegram accounts discover developer groups using `en_SearchBot` + keywords and store group links in MongoDB.
- Listener Telegram accounts join discovered groups and listen for job/hiring messages.
- Preacher Telegram accounts join discovered groups and post admin-provided templates (optionally with a logo), continuously.
- The bot enforces community access: 3-day trial, then 100 Stars monthly.

### Roles

- **Inviter** (`role=inviter`)
  - Logged-in Telegram account used to generate single-use invite links for the required channel/group.
  - The bot revokes the invite link after the user joins.
- **Group Finder** (`role=finder`)
  - Searches for groups using keywords from the bot’s Keywords menu.
  - Stores discovered `t.me` links in `GroupLink` records.
  - Stops when the search bot indicates a daily limit; resumes after a rest window.
- **Listener** (`role=listener`)
  - Joins groups from the stored `GroupLink` pool until ~500 groups per account.
  - Listens to messages in groups and classifies “job/hiring intent”.
  - If a message qualifies, formats it and posts it to the configured Jobs Target chat (or queues it if posting is disabled).
- **Preacher** (`role=preacher`)
  - Joins groups from the stored `GroupLink` pool until ~500 groups per account.
  - Posts message templates in an endless cycle.
  - Skips a group if its own message exists within the last 30 messages.
  - Leaves groups where posting is forbidden (group-level restrictions).
  - Enforces “no two preachers in the same group”.

### Setup

Environment variables (see `.env.example`):

- `BOT_TOKEN`
- `MONGODB_URI`
- `BOT_ADMIN_ID` (bootstrap first admin user id)
- `API_ID`, `API_HASH` (required for Telegram account login via the admin panel)
- `SEARCH_BOT_USERNAME` (default `en_SearchBot`)
- AI classification (optional)
  - `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`)
  - `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `meta-llama/llama-3.1-8b-instruct:free`)

The LLM prompt is stored in `prompt.txt` and must return `true` or `false`.

Run:

```bash
npm install
npm start
```

### Bot admin panel

- **Accounts**
  - Add Telegram accounts and choose a role (Listener / Preacher / Group Finder / Inviter) before login.
  - Start/stop Join/Search and Listen/Preach loops per account.
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

### Community access enforcement

- Users must `/start` the bot to create a DB record and begin the 3-day trial.
- When trial expires, users are removed from the required group/channel (kick, not ban).
- Paid membership is 100 Stars monthly, with reminders (3 days before expiry and during trial at 8h/2h).
- Payments are recorded as pending until the user joins the required chats; joining activates/extends the subscription.
- Anyone joining required chats without an active trial/subscription record is removed (admins are exempt).
