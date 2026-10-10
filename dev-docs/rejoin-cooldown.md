# Rejoin Cooldown and Membership Events

Applies to `src/services/rejoinCooldownService.ts`,
`src/handlers/membership.ts`, `src/commands/jail.ts` (`/mystatus`,
`/paybail`), and migrations `015_rejoin_cooldowns` / `016_membership_events`.

## Cooldown lifecycle

A member who leaves and rejoins is muted for `config.rejoinCooldownSeconds`
(default 1 hour). The mute **pauses** while the member is away: the owed time is
frozen and one more interval is added on each rejoin, so leaving to dodge the
mute only extends it.

Example (`rejoinCooldownSeconds = 3600`):

1. Leave, rejoin → muted 1h.
2. Leave after 10 min → 50 min owed, frozen.
3. Rejoin → muted 50 min + 1h = 1h50m.
4. Repeat: each leave freezes the remainder, each rejoin adds another hour.

State is split so the existing mute machinery is reused unchanged:

- `user_rejoin_cooldowns` (`user_id` PK) holds `pending` (a leave is waiting to
  be re-enforced) and `remaining_seconds` (the frozen remainder).
- The live Telegram restriction is written with
  `muteMember(..., "cooldown")` into `user_rate_limit_mutes`, so the message
  filter (which reads `MAX(muted_until)` across kinds) and the periodic mute
  cleanup enforce and release it with no extra wiring.

`recordMemberLeave` is a no-op for owners/admins/whitelisted users and is
idempotent (a second leave signal while already away is ignored). A first-ever
join never triggers a cooldown: `pending` is only set by a leave.

If the user already has an active jail, rate-limit mute, or other open jailing
when they rejoin, the cooldown is skipped (`pending` cleared, no new jailing).
Otherwise the cooldown would open a second, cheaper payable jailing that
`/paybail` could settle to lift the real mute via `releaseMember`. The
cooldown's own previous jailing is excluded from that check. A jail that starts
during the `muteMember` await is caught by a second check before the jailing is
opened, so two open jailings cannot coexist even under interleaving.

Both delivery paths drive this: the service messages (`new_chat_members` /
`left_chat_member`) and the `chat_member` update. Telegram may send only one of
them (or both), so neither is trusted alone. Duplicates are harmless: the event
log collapses a same-type event within 10s, and `recordMemberRejoin` /
`recordMemberLeave` are idempotent on the `pending` flag. A leave from
`restricted` (already muted) counts. The member tag is applied once, on the
service-message path.

A pre-existing bug made the `chat_member` path dead: the `chat_member` handler in
`registerIdentityBlockModeration` did not call `next()`, so it stopped the
membership `chat_member` handler from ever running (all joins were recorded from
`new_chat_members` only). It now passes through.

## Buy-out (reuse of the bail flow)

Each active cooldown opens or extends a `jailings` row with
`reason = 'rejoin_cooldown'` and the flat `config.defaultJailBailAmount`.
Because it is an ordinary jailing, the whole existing pipeline works unchanged:
`/paybail` shows the Jailing ID and amount, `/verifybail <txhash>` and the
deposit listener verify the memo/amount and call `releaseMember`, and
`JailService.payJailing` calls `clearOnBuyout` so the accrued cooldown does not
survive the payment.

- `/paybail` decides whether a user is payable from the active `jailing`, not
  only from `users.muted_until`, so it works for cooldowns.
- `/mystatus` shows an active cooldown with its remaining time and buy-out price
  via `getActiveCooldown`.
- Do **not** delete the `user_rate_limit_mutes` row on buy-out: `releaseMember`
  needs the stored permission binding to restore the member's real rights.
  `clearOnBuyout` deletes only `user_rejoin_cooldowns`.
- Starting a real jail cancels any open cooldown jailing (`cancelOpenCooldown`,
  called from `JailService.jailUser`), so a cooldown memo can never be paid to
  lift a jail through `releaseMember`'s all-kind clear.

## Membership event log

`user_membership_events` (migration 016) is an append-only join/leave log:
`user_id`, `chat_id`, `event_type` (`join`/`leave`), `source`, `occurred_at`.
The bot is the sole writer; consumers read it live and never write back. It has
no foreign key (unlike `user_rejoin_cooldowns`) so history is durable even for a
user not recorded in `users`. The CAC Museum mini-app reads it read-only from
this DB via `CACMIN_BOT_DB_PATH` and shows the counts on its per-user view.

- `user_memberships` still records only the first observed join (member age);
  the event log records every transition.
- Recording happens alongside the `chat_member` transition handling in
  `membership.ts` (`recordMembershipEvent`).

## Configuration

- `REJOIN_COOLDOWN_SECONDS` → `config.rejoinCooldownSeconds` (default `3600`;
  `0` disables the feature). Buy-out price is the shared jail bail default
  (`DEFAULT_JAIL_BAIL_AMOUNT`, `config.defaultJailBailAmount`).
