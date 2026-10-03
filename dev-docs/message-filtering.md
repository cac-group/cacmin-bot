# Message Filtering and Response Dedupe

Applies to `src/middleware/messageFilter.ts`, `src/utils/autoDelete.ts`,
`src/services/rateLimitService.ts`, `src/services/restrictionService.ts`,
`src/services/chatMuteService.ts`, and `src/services/spamLimiterService.ts`.

## Chat muting

All Telegram muting goes through `src/services/chatMuteService.ts`.
`user_rate_limit_mutes` is keyed on `(user_id, kind)` — migration 012 — so each
mute source (rate limit, flood, jail, reaction spam, identity block, duel,
restriction) holds its own deadline and captured binding and a short jail never
overwrites a long rate-limit mute.

- `muteMember(kind)` denies the explicit `CHAT_MUTE_PERMISSIONS` set, clamps the
  deadline to at least now + 31s (Telegram treats a sub-30s `until_date` as
  permanent), keeps the furthest-out deadline for that kind, captures the
  member's prior binding via `getChatMember`, stores it in `permission_snapshot`,
  and posts a short `@user has been muted.` notice.
- `releaseMute(kind)` deletes that kind's binding once its deadline passes and
  only re-applies the captured permissions when no other kind is still active.
  It is idempotent (a second call for a missing row is a no-op), so the two
  cleanup timers cannot double-restore or double-announce.
- A `status` binding (administrator/creator) is never applied as a permission
  set — that would risk demoting them; the binding is just cleared.
- `RateLimitService.cleanExpiredMutes` runs on `config.intervals.muteCleanupMs`
  and releases every expired binding by kind. `JailService.applyTelegramMute`
  records the matching `jail`/`reaction_spam`/`identity_block` kind so
  `cleanExpiredJails` releases exactly the jail binding at expiry.
- Announcements are skipped when no real `@username` is known (placeholders like
  `user_123` are ignored).

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

`RateLimitService.muteUser` delegates to `chatMuteService.muteMember` (see
above) and `cleanExpiredMutes` restores through it. Both restore paths skip the
Telegram restore while a separate jail is still active. A failed mute must not
abort the warning: the call is wrapped in `try/catch` and logged.

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