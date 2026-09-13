# User Identity and Statistics

Policy: the **Telegram user id is the only user identity key**. Usernames and
display names are mutable, non-unique attributes and are used for display,
search, and human input only — never to store or join per-user state.

## Bot DB (`bot.db`) — fully id-keyed

Every per-user table is keyed by `users.id` (the Telegram id): `users`,
`user_balances`, `transactions`, `violations`, `jail_events`,
`user_restrictions`, `duels`, `giveaways`, `giveaway_claims`, `user_rate_*`,
`shared_account_permissions`, and `user_memberships`.

Persistence guarantees:

- There is no `DELETE FROM users` anywhere. Leaving or being kicked/banned does
  not remove or reset a user row or any statistic.
- `users.username` is updated in place (`ensureUserExists`), so renaming follows
  the same id and stats are never split across names.
- The only stats reset is the intentional `warning_count = 0` in
  `/clearviolations`.
- `duelService` only deletes a duel row when a just-created duel fails escrow
  funding (rollback); completed duel history is retained.
- Gambling stats are aggregated from `transactions` by user id.

## Explorer DB — id-keyed authoritative user stats

`telegram_users` holds the authoritative per-user record: `message_count`,
`first_seen_unix`, `last_seen_unix`, `first/last_message_at`, current identity,
and normalized search fields, all keyed by `user_id`. `telegram_user_aliases`
and `telegram_user_identity_history` record every observed username/name for
that id. `messages.author_user_id` is the resolved author id (~98% of rows).
No code deletes `telegram_users`; stats survive leaves and kicks.

The bot reads it by id only:
`ChatIndexerService.getActiveTimeStats(userId)` matches
`COALESCE(author_user_id, user_id) = ?` and no longer backfills or matches by
display name.

## Known name-based surfaces (not identity)

- `messages.author` and `messages_fts`: the denormalized display string used for
  search/rendering. The id is `author_user_id`.
- `authors` table and `/api/authors`, `/api/author/:name`: a **name-keyed**
  aggregate (`GROUP BY author`), rebuilt by `refreshAuthorStats`. It is the one
  remaining place where per-user statistics split when a display name changes
  (or merge when two users share a name). Migrating it to id-keyed
  `telegram_users` is a follow-up in the explorer repo.
- `resolveUser` / `getUserIdByUsername`: resolve human `@username` input to an
  id. Resolution is now id-stable: `ensureUserExists` records each previous
  username in `user_aliases`, and `findUserIdByUsername` matches the current
  username **union** the alias history. If a username maps to more than one id
  (a reused username), resolution returns null so callers must use an explicit
  numeric id rather than risk acting on the wrong account. Aliases are only
  captured going forward, so names changed before this shipped are not matched.
