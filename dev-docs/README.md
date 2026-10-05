# Dev Docs

Living project documentation. Code is ground truth; these docs record knowledge
that has no home beside the code.

## Documents

- `configuration.md` — `src/config.ts` is the single source of truth for
  tunable values; group map, the "no local tuning constants" rule, and mock
  gotchas.
- `message-filtering.md` — how the group message filter enforces flood/rate
  limits and restrictions, and how bot responses are deduplicated under
  concurrent updates.
- `reaction-spam.md` — who reaction spam detection targets and how it enforces.
- `identity-blocks.md` — name/username block matching and its temporary jail.
- `restrictions.md` — violation-response dedupe, restriction labels, and
  `/bangif`.
- `user-identity.md` — userId-as-sole-key policy, persistence guarantees, and
  the remaining display-name-keyed surfaces.
- `interactive-menus.md` — the one-message rule, callback answering, entry
  points, permission model, and removed dead menu code.
- `database-audit-2026-09-28.md` — read-only prod DB audit plus a verification
  pass: confirmed findings, corrections, mixed-unit `bail_amount` columns,
  indexer reaction FK orphans, and legacy tables.

## Logs

- `logs/2026-09-10.md` — ongoing work log, newest entry last.
- `logs/2026-09-12.md` — reaction spam tightening + flood limiter.
- `logs/2026-09-28.md` — database audit and verification pass.
- `logs/2026-10-02.md` — centralize tunable constants into `config.ts`.
- `logs/2026-10-03.md` — fix rate-limit muting (`ctx.telegram` vs `bot.telegram`)
  and error-metadata logging.
- `logs/2026-10-05.md` — `/help` cleanup; fines consolidated into a fixed
  69.420 JUNO bail; admin/owner reserve-funded bail; fine config dropped.