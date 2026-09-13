# Reaction Spam Detection

Applies to `src/handlers/reactionSpam.ts` and `src/handlers/spamReacts.ts`.

## Who is checked

Every group reaction is logged. Before any enforcement the handler skips:

- **Elevated users** (`checkIsElevated`: `owner`, `admin`, `elevated`).
- **Established users** — either `users.message_count >= 5`
  (`NEW_USER_MESSAGE_LIMIT`) **or** a tracked account at least 14 days old
  (`NEW_USER_MAX_AGE_SECONDS`). Counts are incremented by the message filter,
  and exemptions are cached in-memory once confirmed. The age fallback only
  applies when `created_at` is known, so a user the bot has never recorded is
  still treated as new.
- **Reaction removals** (`new_reaction.length === 0`) and users already
  actioned this session.

So enforcement only ever targets new accounts that have no elevated role.
The dual condition (Option B, 2026-09-13) exists because ~1,500 long-time
members have zero indexed group messages; without the age fallback they would
stay classified as new forever.

## Enforcement methods

1. **Profile match — kick.** `getChat` bio / personal-channel title is tested
   against built-in patterns plus DB patterns managed by `/addspamreact` etc. On
   match the user is kicked (`banChatMember` + immediate `unbanChatMember`) and
   a fun message is posted. No permanent ban.
2. **Velocity — kick (ban + immediate unban).** 3 reactions within 60 seconds
   (`VELOCITY_REACTION_LIMIT` / `VELOCITY_WINDOW_MS`) triggers a kick so a false
   positive can rejoin. The tracker is keyed `userId:chatId` and cleared on
   action.

Both use in-memory state, so a restart clears the short window.

## No permanent bans

As of 2026-09-13 the bot never permanently bans. The two former permanent-ban
paths are now: reaction profile match → **kick**, identity block → **temporary
jail** (see `identity-blocks.md`). "Kick" is implemented as `banChatMember`
immediately followed by `unbanChatMember`.

## History note

"Established" previously meant account age ≥ 14 days (`users.created_at`), then
briefly message count only. A `users.message_count` column was added to back
this; the older `user_message_counts` table had been dropped in migration 002.
Migration 005 backfills the counter from the explorer message index
(`INDEXER_DB_PATH`), grouping messages by the author's resolved user id
(`messages.author_user_id`, falling back to `user_id`) — never by display name.
`author_user_id` is populated on ~98% of indexed messages.
