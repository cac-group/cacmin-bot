# Configuration

`src/config.ts` is the single source of truth for all tunable runtime values.
Environment variables (documented in `.env.example`) override defaults; tests
seed `process.env` in `tests/setup.ts`.

## Rule

Runtime code imports `config` and reads a field. It must not declare its own
module-level tuning constant. The one exception is a value that is genuinely
local to a single algorithm and has no operational meaning (e.g. SQL string
fragments, state keys, the `SAFE_FLAGS` allow-list) — those stay beside the
code. If in doubt, ask whether an operator would ever want to change it without
a rebuild; if yes, it belongs in `config`.

Migration files are historical snapshots and keep their own frozen constants.

## Groups

| Group | Purpose |
| --- | --- |
| top-level (`botToken`, `junoRpcUrl`, `memberTags`, `spamLimit`, ...) | pre-existing core settings |
| `intervals` | `setInterval` periods for background tasks in `bot.ts` |
| `reactionSpam` | new-user exemption, velocity detection, bio patterns, jail messages |
| `gambling` / `duel` | game economics (bet/wager limits, payout multiplier, timeout) |
| `defaultJailBailAmount` | fallback bail when none is configured |
| `chain` | withdrawal gas price/limit; fee is derived from the gas price |
| `price` | CoinGecko cache, id, rolling-average window, history retention, URL |
| `timing` | menu expiry, response dedupe, session timeout, pattern cache TTL |
| `limits` | regex length, random-delete defaults |
| `indexer*` | embedding concurrency, context windows, trigger thresholds |
| `identityCrawl*` | crawl throttle and 429 retry budget |
| `botIdentity` | support username, sticker pack name and file id |

Content constants (`reactionSpam.bioPatterns`, `reactionSpam.jailMessages`,
`botIdentity.cacgifsFirstStickerId`) are literals in `config.ts`; they are
centralized but not env-tunable.

## Gotchas

- Tests that `vi.mock("../../src/config", ...)` must include every field the
  module under test reads at import time, or module load throws on `undefined`.
- `junoApiUrl` and `junoRpcUrl` are always populated by `config`, so services
  read them directly rather than re-declaring fallback URLs.
- `restrictionDurations` was removed: it was declared but never read. Restriction
  durations come from command arguments and the database.
- `BOT_USERNAME` was removed from `.env.example`: it was documented as required
  but never read by the code.
