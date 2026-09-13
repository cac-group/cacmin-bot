# Reaction Spam Detection

Applies to `src/handlers/reactionSpam.ts` and `src/handlers/spamReacts.ts`.

## Who is checked

Every group reaction is logged. Before any enforcement the handler skips:

- **Elevated users** (`checkIsElevated`: `owner`, `admin`, `elevated`).
- **Established users** — anyone with `users.message_count >= 5`
  (`NEW_USER_MESSAGE_LIMIT`). Counts are incremented by the message filter and
  cached in-memory once confirmed.
- **Reaction removals** (`new_reaction.length === 0`) and users already
  actioned this session.

So enforcement only ever targets genuinely new accounts (fewer than 5 lifetime
group messages) that have no elevated role.

## Enforcement methods

1. **Profile match — permanent ban.** `getChat` bio / personal-channel title is
   tested against built-in patterns plus DB patterns managed by
   `/addspamreact` etc. On match the user is banned (`banChatMember`) and a fun
   message is posted.
2. **Velocity — kick (ban + immediate unban).** 3 reactions within 60 seconds
   (`VELOCITY_REACTION_LIMIT` / `VELOCITY_WINDOW_MS`) triggers a kick so a false
   positive can rejoin. The tracker is keyed `userId:chatId` and cleared on
   action.

Both use in-memory state, so a restart clears the short window.

## History note

"Established" previously meant account age ≥ 14 days (`created_at`). It now
means lifetime message count, per operator request, so old-but-silent accounts
are no longer silently exempt. A `users.message_count` column was added to back
this; the older `user_message_counts` table had been dropped in migration 002.

The counter only increments once the column exists, so migration 005 backfills
it from the explorer message index (`INDEXER_DB_PATH`), grouping messages by the
author's resolved user id (`messages.author_user_id`, falling back to
`user_id`) — never by display name. `author_user_id` is populated on ~98% of
indexed messages. Users with no indexed group messages remain at 0 and are
still treated as new; if that proves too aggressive in practice, the unmapped
set could be grandfathered the same way migration 005 handles a missing
indexer.
