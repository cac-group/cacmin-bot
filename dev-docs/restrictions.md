# Restrictions and Violation Responses

Applies to `src/services/restrictionService.ts`, `src/handlers/restrictions.ts`,
`src/utils/restrictionLabels.ts`, and `src/utils/autoDelete.ts`.

## Violation response dedupe

When a restriction is violated, `sendTrackedViolationResponse` posts a notice
and records it under a dedupe key. The key is **class-based**:
`restriction:<type-or-penalty>` (e.g. `restriction:no_specific_gif`,
`restriction:immediate_jail`, `restriction:mute`, `restriction:auto_jail`).

The previous notice for the same class is deleted before the new one is sent,
so a user never sees two of the same notice. The key must not include the
message text: notices vary by violation count ("1/5" vs "2/5"), and an
earlier build keyed on the full text, which produced back-to-back duplicates
(the bug this doc records). `violationResponseKey()` returns the stable key.

## Labels

Stored identifiers are stable (DB rows, command parsing); only the display is
translated. `restrictionLabel()` maps them, notably `no_specific_gif` →
"banned gif". Violation notices, `/listrestrictions`, and `/addrestriction`
confirmation use the label.

## `/bangif`

Bans a specific GIF by `file_unique_id` (the animation's stable fingerprint):

- `/bangif` (reply to the GIF) — ban for that GIF's author.
- `/bangif <gif_id>` (reply) — ban the given id for that author.
- `/bangif <@username|userId> <gif_id>` — ban for a named user.
- `/bangif -g [gif_id]` — ban globally (all users).

Per-user bans add a `no_specific_gif` user restriction; `-g` inserts a
`no_specific_gif` global restriction. Owners/admins are immune to per-user bans.
`/getgifid` still retrieves an id by reply if needed.

## Severity and auto-jail

`user_restrictions.severity` is `delete` (default), `mute`, or `jail`. Repeated
violations within 60 minutes trigger auto-jail after `violationThreshold`
(default 5). All penalties are temporary (mute/jail) — the bot never bans.
