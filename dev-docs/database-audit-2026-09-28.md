# Prod database audit — 2026-09-28

Read-only sweep. **No changes were made to production.** Recommendations only.

- Container: LXD `tgbot` on remote `nodev2` (10.70.48.203)
- Bot DB: `/opt/cacmin-bot/data/bot.db` (SQLite, WAL, 762 KB / 186 pages)
- Indexer DB: `/opt/telegram-chat-explorer/data/chatexport-2026-03-18.db` (4.5 GB)

## Health summary

- `PRAGMA quick_check` → `ok`; `PRAGMA foreign_key_check` → 0 violations
  (`foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`).
- No orphaned rows in `user_memberships`, `user_aliases`, or any FK-checked table.
- Indexer DB: `messages` 927,878 = `messages_fts` 927,878 (FTS in sync);
  `embeddings` 803,719, zero orphans (also `PRIMARY KEY(message_id)` so no dupes).
- `price_history` self-prunes to 7 days, as designed (oldest = 2026-09-21).

Nothing is broken. Findings below are disk reclamation, hygiene, and one
historical data anomaly.

## Findings

### 1. Stale indexer backups — 5.9 GB (highest-value cleanup)

```
/opt/telegram-chat-explorer/data/chatexport-2026-03-18.db.bak-20260421-091338  2.9G  Apr 21
/opt/telegram-chat-explorer/data/chatexport-2026-03-18.db.bak-20260703-145308  3.0G  Jul  3
```

Two old full copies of the 4.5 GB indexer DB. If they are not a deliberate
retention set, deleting them reclaims ~5.9 GB. Confirm retention policy first.

### 2. Indexer embeddings — 3.1 GB (decision needed)

`/opt/telegram-chat-explorer` is 6.6 GB, dominated by:

| object | size |
|---|---|
| `embeddings` table | 3.1 GB |
| `messages` (+ FTS/indexes) | 835 MB |
| `media/` | 238 MB |

`INDEXER_EMBEDDINGS_ENABLED=false`, so the table is frozen. It is internally
consistent, but if embeddings are not consuming value, dropping/rebuilding is
the single biggest space lever after the backups. Owner decision.

### 3. Bot DB WAL — 4.0 MB vs 762 KB DB

The WAL sits at the default `wal_autocheckpoint = 1000`-page threshold. It is
not data loss risk; a one-off `PRAGMA wal_checkpoint(TRUNCATE)` (with no other
writers) reclaims ~4 MB. Cosmetic.

### 4. Stale `bot.db.backup` — 188 KB (Nov 2025)

`/opt/cacmin-bot/data/bot.db.backup` predates all current data. Confirm it is not
the restore target of the backup job, then remove.

### 5. Historical double-credit anomaly (data correctness, needs owner call)

`transactions.tx_hash = 0ADDDC…85146B` appears twice:

```
id 1  deposit  -> UNCLAIMED (-3)  2 JUNO  2025-11-03  memo ".b'@"  (garbage)
id 4  deposit  -> user 15000       2 JUNO  2025-11-28  memo "15000"
```

The same on-chain deposit was credited to the unclaimed account and later
re-credited to user 15000 without a matching debit of `-3` (which now holds 0,
so it is no longer visibly double-counted). Impact ~2 JUNO, historical.

Root cause class: `transactions` has **no** unique constraint on `tx_hash`
(the guard is `processed_deposits.tx_hash UNIQUE`). Adding a partial
`UNIQUE INDEX ON transactions(tx_hash) WHERE tx_hash IS NOT NULL` would prevent
future double-credits — but first verify that a hash can never legitimately
produce two rows (allocation flows may intentionally create a second row).

### 6. Redundant indexes in bot schema (negligible here, hygiene only)

At 186 pages these save essentially nothing; worth cleaning only in
`src/database.ts` for correctness of intent:

| index | redundant with |
|---|---|
| `idx_processed_deposits_tx_hash` | `UNIQUE(tx_hash)` |
| `idx_shared_accounts_name` | `UNIQUE(name)` |
| `idx_giveaway_claims_giveaway` | prefix of `UNIQUE(giveaway_id, user_id)` |
| `idx_restrictions_user` | prefix of `UNIQUE(user_id, restriction, restricted_action)` |

### 7. Empty legacy `rules` table

`rules` has 0 rows and no code references. Drop via migration when convenient.

### 8. No `sqlite_stat1` / never `ANALYZE`d

Planner uses defaults. Harmless at this size; a `PRAGMA optimize` on connection
close is cheap insurance as data grows.

### 9. Expected sparse data (no action)

- 2312/2358 users have no `user_balances` row; 2239 no membership; 2332 no alias.
- Empty tables (`fine_config`, `spam_patterns`, `identity_block_patterns`,
  `shared_*`, `rate_limit_reset_payments`, `transaction_locks`) are normal.
- 563/579 transactions have `tx_hash IS NULL` — internal ledger entries, expected.

## Recommended priority

1. Confirm retention, then delete the two stale indexer backups (~5.9 GB).
2. Decide whether to keep the 3.1 GB `embeddings` table.
3. Confirm and remove the stale `bot.db.backup` (~188 KB).
4. Optional correctness: unique `transactions.tx_hash` (partial), after verifying
   allocation flows cannot legitimately duplicate a hash.
5. Optional hygiene: drop redundant indexes and the unused `rules` table in the
   schema; enable periodic `PRAGMA optimize`.

All items 1–3 are disk-only and reversible with backups; item 4 touches the
money path and should be a deliberate, tested change.

---

## Verification pass — 2026-09-28 (second read-only sweep)

Re-ran the sweep against the same live DBs (`tgbot`, `10.70.48.203`). No changes
made. Findings 1–9 are confirmed with two corrections; new findings A–G follow.

### Confirmations

| # | Status | Evidence |
|---|---|---|
| health | ✅ | `quick_check`/`integrity_check` = `ok`; `foreign_key_check` = 0 violations in `bot.db` |
| 1 | ✅ | `…bak-20260421-091338` 3,113,271,296 B; `…bak-20260703-145308` 3,197,927,424 B (~5.88 GiB) |
| 2 | ✅ | base DB 4,727,599,104 B; `embeddings` 803,719 (unchanged — frozen); `messages` 927,879 (audit 927,878, +1 live) |
| 3 | ✅ | `bot.db-wal` 4,136,512 B vs `bot.db` 761,856 B; `wal_autocheckpoint` = 1000 |
| 4 | ✅ | `bot.db.backup` 192,512 B, Nov 3 2025 |
| 5 | ✅ | ids 1 (`to_user -3`) and 4 (`to_user 15000`), same hash `0ADDDC…85146B`, both 2,000,000 µJUNO; the only duplicate hash in `transactions` |
| 6 | ✅ | all four explicit indexes duplicate a UNIQUE/PK index (`PRAGMA index_list`) |
| 8 | ✅ | `PRAGMA sqlite_stat1` → `no such table` (never `ANALYZE`d) |
| 9 | ✅ | 2358 users; 2312 no balance, 2239 no membership, 2332 no alias; 563/579 null `tx_hash`; same empty tables |

Indexer FTS is fully in sync: `messages` = `messages_fts` = `messages_fts_docsize`
= 927,879, with zero orphan `embeddings` and no duplicate `message_id`s.

**Health caveat:** `PRAGMA foreign_keys` reads `0` on a plain `sqlite3` connection
because it is a per-connection setting; `src/database.ts:27` sets it `ON` for the
app, so the audit's "foreign_keys = ON" describes the app connection, not the CLI.
`journal_mode=wal` and `synchronous=NORMAL (2)` confirmed.

### Corrections

- **#7 is partly wrong.** `rules` has 0 rows, but it *is* referenced:
  `scripts/setup-db.ts:15` seeds 8 default rules with
  `INSERT OR IGNORE INTO rules`, while `src/database.ts` no longer creates the
  table. A fresh `bun run setup-db` would therefore fail with
  `no such table: rules`. It is dead in the running bot but not dead in the repo.
- **#6 context.** The unique index that makes `idx_restrictions_user` redundant is
  `idx_user_restrictions_unique`, created by migration 007, not `database.ts`. That
  index is on `(user_id, restriction, restricted_action)`; SQLite treats NULLs as
  distinct, so it does **not** dedupe rows with `restricted_action IS NULL`
  (currently 0 such rows, so no live impact).

### New findings

**A. Indexer reaction tables have 204 FK violations (integrity).**
`PRAGMA foreign_key_check` on the indexer DB reports 103 rows in
`telegram_reaction_state` and 101 in `active_message_reactions` whose
`message_id` is absent from `messages`. The audit only checked `embeddings`
orphans. Likely fallout from additive merges or deleted/edited messages against
FKs added after the fact. Recommend a bounded cleanup (or cascade) and a
pre-merge check.

**B. `jail_events.bail_amount` mixes two unit scales (money path).**
167 rows split as: 28 ≥ 1,000,000 (micro-µJUNO, up to `10000000000000.0`), 84
fractional JUNO (`0 < x < 1e6`; `DEFAULT_JAIL_BAIL_AMOUNT = 69.42`), 55 zero.
Migration 001 multiplied historical jail rows by 1e6, but the current writer
(`src/services/jailService.ts`) stores decimal JUNO. Code sums this column for
totals (`src/commands/moderation.ts:504`, `src/commands/jail.ts:229/278`), so those
totals combine units. `violations.bail_amount` is uniformly decimal JUNO (139
rows, 0 micro) and `user_restrictions.auto_jail_fine` defaults to `10.0` — i.e.
the fine/bail columns did **not** end up on the ledger's micro-unit convention.
Verify intended units and normalise before trusting any sum.

**C. Legacy `system_wallets` table.** Present with 1 row
(`user_funds → juno1s6uf7…`), not created by `database.ts`, zero code references.
Same class as `rules`; a drop candidate after confirming nothing external reads it.

**D. Sentinel username `'unknown'`.** 712 users have `username = 'unknown'`
(0 NULL). It is not an identity key (dev-docs `user-identity.md`), but it pollutes
`idx_users_username` and any username lookup that does not explicitly exclude it.

**E. 21 legacy embeddings with `model IS NULL`** (message ids 164741–1137977) —
pre-provenance vectors, ineligible for labelled pgvector search. Harmless; the
scheduled re-embed will not touch them because it selects by model label.

**F. One outlier deposit.** `processed_deposits` id 14 (`amount = 52.0`,
height 37265993, 2026-04-24) is three-plus orders of magnitude below every other
deposit's micro-scale. Either a genuine dust deposit or a mis-scaled write —
worth one row-level look before dismissing.

**G. FK coverage gap.** `user_aliases`, `user_memberships`, `user_rate_limits`,
`user_rate_limit_usage` (and `user_rate_limit_mutes`) declare no FK to `users`,
so their integrity is not covered by `foreign_key_check`. Manual checks today show
0 orphans, but nothing prevents future drift.

### Updated priority

1. Confirm retention, then delete the two stale indexer backups (~5.9 GB).
2. Decide whether to keep the 3.1 GB `embeddings` table.
3. Confirm and remove the stale `bot.db.backup` (~188 KB).
4. **NEW:** resolve `jail_events.bail_amount` mixed units (B) before relying on fine
   totals; reconcile `violations`/`auto_jail_fine` units at the same time.
5. **NEW:** clean or cascade the 204 indexer reaction FK violations (A).
6. Optional correctness: partial unique `transactions.tx_hash` (verify allocation
   flows first).
7. Optional hygiene: drop redundant indexes (and, when confirmed unused, `rules`
   and `system_wallets`); fix `setup-db` vs the dropped `rules` table; enable
   periodic `PRAGMA optimize`; exclude the `'unknown'` username sentinel.

## Resolution (2026-09-28)

Code changes (all tested; migrations apply on the next `cacmin-bot` deploy):

- **D — fixed.** `normalizeUsernameForStorage` + migration 009 null `unknown`/
  `user_<id>` usernames. `userService` no longer writes sentinels.
- **B — fixed.** Migration 010 scales decimal-JUNO `violations.bail_amount`,
  `jail_events.bail_amount`, and `user_restrictions.auto_jail_fine` up to integer
  micro-units (`> 0 and < 1e6`); writers store `AmountPrecision.toDbMicro` and
  readers convert back. Values `>= 1e6` are left untouched. JUNO is now stored as
  integer micro-units everywhere, so it can never exceed 6 decimals.
- **F — fixed.** Migration 011 recomputes real users' `user_balances` from the
  transaction ledger (excluding `bail`'s non-crediting `to_user_id`) and resets the
  system accounts (`-1`, `-3`) to zero, per operator decision.
- **E — fixed.** The `aieng` sidecar failed cuDNN softmax at the full 2048-token
  window and rejected lone surrogates from UTF-16 truncation; capped text tokens at
  512 and added server-side surrogate stripping (`telegram-chat-explorer`), then
  re-embedded. Indexer now has 0 NULL-model embeddings and 0 missing eligible text
  embeddings.

Not changed (recommendations only): A (indexer reaction FK orphans — fix in
`telegram-chat-explorer`), C (`system_wallets`/`rules` drop), G (no safe
consolidation; add FK coverage to the alias/membership/rate tables).
