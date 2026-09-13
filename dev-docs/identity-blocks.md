# Identity Block Enforcement

Applies to `src/handlers/identityBlocks.ts`.

## What it matches

Built-in plus DB-managed (`/addidentityblock`) regexes tested against a user's
first name, last name, full display name, and username. Evaluated on
`new_chat_members` (join), every group `message`, and `chat_member` updates.
Owners and admins are never touched.

## What it does

As of 2026-09-13 a match **jails the user temporarily** instead of permanently
banning them (`jailIfBlockedIdentity`):

1. `ensureUserExists` so the user has a row to mute.
2. `JailService.jailUser` sets `users.muted_until` and writes a `jailed`
   `jail_events` audit row.
3. `restrictChatMember` with all sending permissions disabled and
   `until_date = mutedUntil`.
4. For `message`-source matches the triggering message is deleted.

Duration is `IDENTITY_BLOCK_JAIL_MINUTES` (default `1440` = 24h). Expiry is
handled by the existing periodic `JailService.cleanExpiredJails`, which restores
permissions.

## Why

The bot must never permanently ban. A jail keeps a matching account muted for a
bounded period; the previous `banChatMember` call was removed. Note that a mute
does not stop reactions, so identity blocks are a name/username gate, not a
reaction-spam control (see `reaction-spam.md`).
