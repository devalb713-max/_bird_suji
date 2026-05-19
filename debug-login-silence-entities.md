[OPEN] debug-login-silence-entities

## Symptoms
- Admin login sometimes becomes silent after sending phone number (no “sending code” / “code sent”).
- Bot logs: `400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset ...`

## Expected
- Login flow always replies immediately and progresses deterministically:
  - “Sending verification code…” → “Code sent…” → “Logging in…” → “2FA…” → “Account added…”

## Hypotheses (falsifiable)
1) A Markdown/HTML parse_mode message is failing, and the error is bubbling up / masking the successful login path.
2) The send-code request hangs (network/DC) and no timeout/guard returns control to send a user-visible update.
3) Multiple concurrent login attempts conflict, causing the wrong in-flight session/client to be used for later steps.
4) Some handler replies are blocked behind outbound queue saturation or unhandled promise rejections.
5) The error is emitted from a different handler (not login) but is logged as a generic bot error, making correlation misleading.

## Instrumentation Plan
- Add debug-server reporting for:
  - login step transitions (phone received, connect start/end, sendCode start/end)
  - every reply attempt failure with parse_mode + text preview
  - bot.catch captured errors with update context

## Repro Steps
1) Admin → Accounts → Add Account → choose role → send phone number.
2) Observe whether it replies “Sending verification code…”.
3) If silent, wait 60s; then send the phone number again.

## Evidence
- Pending: trae-debug logs

## Outcome
- Pending
