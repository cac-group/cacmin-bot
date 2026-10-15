# Operations and running state

The bot is **live** in production. This doc records where and how it runs and
points at the authoritative scripts; it does not restate their commands.

## Running state

| | |
|---|---|
| Status | `live` (production) |
| Host | LXD container `tgbot` on remote `nodev2` (`10.70.48.203`) |
| Deploy root | `/opt/cacmin-bot` |
| Service user / group | `cacmin-bot` / primary `cacmin-bot`, supplementary `teleindexer-data` |
| Env file | `/etc/cacmin-bot/cacmin-bot.env` (`0640 root:cacmin-bot`) |
| Runtime | `/opt/bun/bin/bun dist/bot.js` |
| Database | `/opt/cacmin-bot/data/bot.db` |
| Logs | `/opt/cacmin-bot/logs/` (`combined.log`, `error.log`, `exceptions.log`, `rejections.log`) and journald (`SyslogIdentifier=cacmin-bot`) |

The bot also writes the explorer dataset at
`/opt/telegram-chat-explorer/data` and its trigger state at
`/opt/telegram-chat-explorer/state` — granted via `ReadWritePaths` and the
`teleindexer-data` group. See [chat-explorer-integration.md](chat-explorer-integration.md).

## systemd units (in this repo)

| Unit | Role |
|---|---|
| `cacmin-bot.service` | The bot. `ProtectSystem=strict`, `ProtectHome=true`; `ReadWritePaths` = `/opt/cacmin-bot/data`, `/opt/cacmin-bot/logs`, `/opt/telegram-chat-explorer/data`, `/opt/telegram-chat-explorer/state`. |
| `cacmin-bot-update.service` | Oneshot: runs `/usr/local/libexec/cacmin-bot-auto-update`; `ReadWritePaths=/opt/cacmin-bot`. |
| `cacmin-bot-update.timer` | Daily `04:00` (+15m jitter), `Persistent=true`. |

## Install and update

- **Install** (`install.sh`, root): hostname-gated by `CACMIN_EXPECTED_HOSTNAME`
  (default `tgbot`); creates the service user, `teleindexer-data` group, and
  `/opt/cacmin-bot`, `/etc/cacmin-bot`, `/usr/local/libexec`; stages code with
  rollback; `--activate` promotes; writes the env file `0640 root:cacmin-bot`.
- **Update** (`auto-update.sh`, installed as
  `/usr/local/libexec/cacmin-bot-auto-update`): pulls the GitHub release
  `cac-group/cacmin-bot` asset `cacmin-bot-dist.tar.gz`, compares `version.txt`,
  stages, and rolls back on failure.

## CI/CD

- `.github/workflows/ci.yml` — build, typecheck, lint, tests, coverage.
- `.github/workflows/build.yml` — ARM64 build → `cacmin-bot-dist.tar.gz` →
  `latest`/version releases; a `deploy` job runs
  `lxc exec tgbot -- cacmin-bot-auto-update --release … --force` on tags.

## Network dependencies

- Telegram Bot API `http://tgbotapi.lxd:8081` (files `:8082`).
- JUNO RPC/REST and Ollama (`http://192.168.0.170:26886`) per `.env.example`.

## Troubleshooting

- **Database locked.** Only one bot instance may write `bot.db`; stop the other
  instance (or a zombie `bun`/`node` process). WAL plus `busy_timeout=30000`
  absorbs brief contention, not a second writer.
- **Deposit not detected.** Confirm RPC health (`bun run validate`), that the
  memo is exactly the userId, and whether the tx hash is already in
  `processed_deposits`; the owner can force a pass with `/reconcile`.
- **Balance mismatch.** `/reconcile` re-derives balances; inspect the
  `transactions` audit trail.
- **RPC failures.** Fallback endpoints are used automatically and errors are
  logged; see the network dependencies above.

## Admin commands

`/reconcile`, `/walletstats`, `/treasury`, `/botbalance`, and `/processdeposit`
(see `src/commands/`). The command modules are canonical; this list may drift.

## Known hazards

- `package.json` references `./rebuild.sh`, which is not in the tree.
- `scripts/setup-db.ts` seeds a `rules` table that `src/database.ts` no longer
  creates; see [database-audit-2026-09-28.md](database-audit-2026-09-28.md).
- `AGENTS.md` is gitignored local agent state; treat this tree as authoritative
  for project-level knowledge.
