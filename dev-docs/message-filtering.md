# Message Filtering and Response Dedupe

Applies to `src/middleware/messageFilter.ts`, `src/utils/autoDelete.ts`,
`src/services/rateLimitService.ts`, `src/services/restrictionService.ts`, and
`src/services/spamLimiterService.ts`.

## Flood limiter

Before the character rate limits, every group message from a non-elevated user
is passed to `spamLimiterService.recordMessage` (synchronous, in-memory sliding
window of recent message IDs per `user:chat`). When more than
`SPAM_LIMIT_MAX_MESSAGES` (default 5) arrive within `SPAM_LIMIT_WINDOW_MS`
(default 5000), the service reports the sender's last
`SPAM_LIMIT_DELETE_COUNT` message IDs (default 5), clears that user's tracker,
and the filter:

1. deletes the reported messages,
2. jails the sender for `SPAM_LIMIT_JAIL_MINUTES` (default 5) via
   `JailService.jailUser` (`users.muted_until` + jail event audit), and
3. restricts them in Telegram until that time.

No chat message is sent. Set `SPAM_LIMIT_MAX_MESSAGES=0` to disable. Owners,
admins (already skipped earlier in the filter), and the `elevated` role are
exempt. Because `recordMessage` clears the tracker when it fires and is
synchronous with no `await`, concurrent handlers in the same update batch
cannot each trigger a separate jail.

## Lifetime message counter

`messageFilter.ts` increments `users.message_count` for every group message from
a non-whitelisted, non-owner/admin user. Reaction spam uses this to decide
whether someone is still "new" (see `reaction-spam.md`).

## Rate-limit enforcement flow

Every group message from a non-whitelisted user is admitted against persistent
character windows (`RateLimitService.admitMessage`). On violation:

1. The user's message is deleted.
2. The user is restricted until the limiting window resets
   (`RateLimitService.muteUser`, backed by `user_rate_limit_mutes`). While that
   row is active, later messages are silently deleted by the filter.
3. One warning is posted; subsequent violations for the same user reuse the
   same warning slot instead of piling up messages.

## Response deduplication contract

`src/utils/autoDelete.ts` tracks bot responses per `chat:user:eventKey` for a
2-minute window. `prepareResponse`:

- Claims the slot **synchronously** (before any `await`) so concurrent handlers
  for the same key are skipped — a `messageId` of `0` marks an in-flight send.
- Deletes the previous response and returns `true` to allow a replacement, or
  returns `false` when a fresh response is already visible/in-flight. Callers
  must honor the return value and skip sending when it is `false`.

## Concurrency gotcha

Telegraf's long-polling loop processes each update batch with
`Promise.all(updates.map(handleUpdate))` (`node_modules/telegraf/lib/core/network/polling.js`).
A user spamming messages therefore runs the middleware concurrently, and the
rate-limit mute row (read in `messageFilter.ts`) is not yet visible to
same-batch messages. The synchronous slot claim in `prepareResponse` is what
prevents a warning pileup in that case; the mute row only gates later batches.
Do not reintroduce an `await` between the dedupe check and the claim.