# Architecture

How `cacmin-bot` is put together: one long-running Telegram bot process, a
service layer over two SQLite databases, and a live-writer role into the
`telegram-chat-explorer` dataset. Module contracts live in the modules and in
`AGENTS.md`; this doc names them and explains how they connect.

## Shape

A single Bun/TypeScript process. `src/bot.ts` is the entry point; `main()` runs
on import and wires everything:

1. `validateConfig()` (`src/config.ts`) then `initDb()` (`src/database.ts`).
2. Seed configured owners/admins; `LedgerService.initialize()`,
   `await UnifiedWalletService.initialize()`,
   `TransactionLockService.cleanExpiredLocks()`, `initializeRollSystem()`.
3. `createTelegramBot()` (Telegraf), `JailService.initialize(bot)`, then the two
   indexers: `ChatInteractionIndexerService.initialize(bot)` and
   `ChatIndexerService.initialize(bot)`.
4. Register middleware, command handlers, and text/session handlers; set
   intervals; install graceful-shutdown hooks.

Run modes: `bun run dev` (`bun --watch src/bot.ts`), `bun run build` (tsc to
`dist/`), `bun run start` (`bun dist/bot.js`).

## Components

| Module | Responsibility |
|---|---|
| `src/bot.ts` | Entry point: boot sequence, middleware + handler registration, intervals, shutdown. |
| `src/config.ts` | Single source of truth for tunables; reads env, typed `Config`, `validateConfig()`. |
| `src/database.ts` | Owns the bot SQLite DB: connection pragmas, query helpers, base schema, `initDb()`. |
| `src/sqlite.ts` | Runtime DB adapter: `bun:sqlite` in production, `better-sqlite3` only as the Node/Vitest fallback. |
| `src/migrations/` | Ordered, idempotency-checked migrations (`001`–`017`) run at the end of `initDb()`. |
| `src/middleware/` | Global message filtering and audit (`messageFilter.ts`, `index.ts`). |
| `src/commands/` | Slash commands (help, moderation/jail, wallet/deposit, giveaways, gambling, …). |
| `src/handlers/` | Inline/callback, restriction, role, violation, membership, spam-reaction, and identity-block handlers. |
| `src/services/` | Business logic as static-method classes over the DB: ledger, unified wallet, transaction locks, jail, restrictions, mutes, rate/spam limits, shared accounts, user, violations, rejoin cooldown, duels, price, JUNO/REST, RPC verification, and the indexers. |
| `src/utils/` | Logger, precision, safe regex, Telegram helpers, keyboards, user resolver. |
| `scripts/` | Operator utilities: `setup-db.ts`, `validate.ts`, wallet helpers. |

The global middleware chain actually applied in `src/bot.ts` is
`messageFilterMiddleware` then `logPrivilegedCommands`; permission guards
(`ownerOnly`/`adminOrHigher`/`elevatedOrHigher`) are attached per command.
Commands and handlers each export a `register*Handlers(bot)` that `bot.ts`
calls.

## Data

The bot owns `data/bot.db` (prod `/opt/cacmin-bot/data/bot.db`): schema is inline
DDL in `src/database.ts` plus the `src/migrations/` modules, opened with WAL,
`foreign_keys=ON`, `busy_timeout=30000`, `synchronous=NORMAL`. Tables cover
users/balances/transactions, violations/jailings/restrictions, deposits/locks,
giveaways, shared accounts, duels, spam/identity patterns, and
`user_membership_events` (migration `016`).

Separately, when `INDEXER_ENABLED` is on, the bot is the **live writer** into the
`telegram-chat-explorer` dataset (a second SQLite file at `INDEXER_DB_PATH`). The
schema, embeddings, and pgvector index are owned by that project; the bot only
appends. The contract is
[chat-explorer-integration.md](chat-explorer-integration.md) — read it before
touching any shared table or the embedding hand-off.

## Financial core

A **single shared on-chain JUNO wallet** backs every internal balance; the SQLite
ledger is the source of truth for ownership. The account model, ID ranges, fund
flows, and access matrix are canonical in [`LEDGER.md`](../LEDGER.md) — link to
it, do not restate it here. Engineering invariants:

- **Exact money.** All amounts are integer microJUNO (1 JUNO = 1e6) via
  `AmountPrecision` (`src/utils/precision.ts`); use `toDbMicro`/`fromDbMicro` at
  the DB boundary. Never use floating point for amounts.
- **Locks.** Every balance-changing operation acquires a DB transaction lock
  (`src/services/transactionLock.ts`) and releases it in a `finally` block; locks
  expire and are cleaned on startup.
- **Ledger.** Every operation writes double-entry records; `LedgerService` owns
  balances and the audit trail.
- **Deposits.** Detected by RPC polling; the memo is decoded with cosmjs
  (`decodeTxRaw` in `src/utils/txMemo.ts`), credited idempotently via
  `processed_deposits`, and a startup reconciliation
  (`UnifiedWalletService.reconcileStartupDeposits`) catches deposits missed
  during downtime.

## Roles

Four tiers, `owner > admin > elevated > pleb`, enforced by middleware guards
`ownerOnly`, `adminOrHigher`, and `elevatedOrHigher`
(`src/middleware/index.ts`; `elevatedAdminOnly` is a deprecated alias). Separation
of powers is deliberate: admins moderate but have no treasury, config, or wallet
access, and the promotion hierarchy is owner → admin/elevated, admin → elevated.

## Relationships

- Bot DB ← all services; migrations own its shape.
- Bot → explorer dataset via `src/services/chatIndexerService.ts`,
  `chatInteractionIndexerService.ts`, and `identityCrawlService.ts`
  ([chat-explorer-integration.md](chat-explorer-integration.md)).
- `user_membership_events` is bot-owned and read by the explorer/museum
  ([rejoin-cooldown.md](rejoin-cooldown.md)).

## Running state and operations

Live in the `nodev2:tgbot` LXD container; see [operations.md](operations.md) for
the host, systemd units, install/update flow, and paths.

## Current state

Stable. Known documentation drift to resolve during adoption is tracked in
[database-audit-2026-09-28.md](database-audit-2026-09-28.md) and the logs.
