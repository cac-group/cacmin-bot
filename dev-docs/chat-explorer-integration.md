# Chat Explorer Integration

The bot is the **live writer** into the `telegram-chat-explorer`
(`teleindexer`) SQLite dataset. That repository owns the schema, the
embeddings/pgvector index, and the API/UI; this bot only appends live group
activity into its dataset. Anything that changes the shared tables or the
embedding hand-off is a cross-repo change and must be coordinated.

Counterpart doc: `telegram-chat-explorer/dev-docs/integration-cacmin-bot.md`.

## Direction of the dependency

- **cacmin-bot → explorer DB.** The bot opens the dataset read/write and appends
  messages, authors, interactions, and (optionally) embeddings.
- **explorer → owns the schema and embeddings.** The explorer's
  `teleindexer-embed-missing.{path,service,timer}` units run the embedding
  worker; the bot only pokes a trigger file. In production the explorer runs
  with `LIVE_INDEX_ENABLED=false` and this bot is the sole live writer.

## Configuration contract

Configured in `src/config.ts` (see `configuration.md`); all of it lives in
`INDEXER_*` env vars.

| Var | Meaning |
| --- | --- |
| `INDEXER_ENABLED` | Master switch for live indexing (default `false`). |
| `INDEXER_DB_PATH` | Path to the explorer dataset SQLite file (required when enabled). |
| `INDEXER_DATASET_ID` | Dataset id used in media paths (default `live`). |
| `INDEXER_MEDIA_DIR` | Base dir for downloaded media (default alongside the DB). |
| `INDEXER_EMBEDDINGS_ENABLED` | Let the bot embed directly. Default `false` so the explorer's worker owns embeddings/pgvector; set `true` only for standalone deployments without that worker. |
| `INDEXER_EMBED_TRIGGER_FILE` | Trigger file the bot touches so `teleindexer-embed-missing.path` starts. Defaults to `../state/embed-missing.trigger` next to the explorer data dir. |
| `INDEXER_EMBED_TRIGGER_BATCH_SIZE` | Eligible text/caption inserts before touching the trigger; `0` disables. Default `25`. |
| `INDEXER_EMBED_CONCURRENCY`, `INDEXER_THREAD_WINDOW`, `INDEXER_LOCAL_WINDOW`, `INDEXER_MAX_CONTEXT_CHARS`, `INDEXER_EMBED_TRIGGER_MIN_TEXT_LENGTH` | Embedding/context tuning. |

The explorer also reads `LIVE_INDEX_ENABLED`, `LIVE_EMBED_TRIGGER_FILE`, and
`LIVE_EMBED_TRIGGER_BATCH_SIZE`; the bot accepts those as aliases for the
`INDEXER_*` names.

## Tables the bot writes (treat as a contract)

Appended/updated by `src/services/chatIndexerService.ts`:
`messages`, `authors`, `topics.message_count`, `message_topics`, `embeddings`,
`image_descriptions`, `vector_sync_state`, `live_index_state`, `dataset_meta`.

Appended/updated by `src/services/chatInteractionIndexerService.ts`:
`telegram_users`, `telegram_user_identity_history`, `telegram_user_aliases`,
`message_user_mentions`, `unresolved_user_references`,
`active_message_reactions`, `telegram_reaction_state`,
`interaction_dirty_messages`, and `messages.author_user_id`.

`src/services/identityCrawlService.ts` records crawl progress in the bot's own
`system_state` but writes identities into the explorer's user tables above.

## Membership statistics (bot-owned, consumers read only)

`user_membership_events` (append-only join/leave log, migration 016) lives in
the bot's own database, not the explorer dataset. The bot is the sole writer;
telegram-chat-explorer and the CAC museum mini-app read it and never write to
it. The museum reads it by opening the bot DB read-only via
`CACMIN_BOT_DB_PATH` and surfaces the counts on its per-user view (see
`telegram-chat-explorer/src/db/membershipStats.ts`). See `rejoin-cooldown.md`.

## Mirrored logic

The bot deliberately mirrors the explorer's embedding context builder
(`telegram-chat-explorer/src/embeddings/generate.ts`); see
`chatIndexerService.ts` (`runEmbeddingBatch`, `buildEmbeddingContext`). A change
to windowing, provenance labels, or the stored `model` tag on either side must
be mirrored on the other and reflected in both docs.

## Deployment coupling

`cacmin-bot.service` runs with `SupplementaryGroups=teleindexer-data` and
`ReadWritePaths=/opt/telegram-chat-explorer/data` + `/state`, so the bot can
write the dataset and touch the trigger file under systemd hardening.

## Change protocol

1. Prefer additive changes to the shared tables; the explorer reads them.
2. The explorer's tests (`src/db/authorStats.test.ts`, `access-gating.test.ts`)
   simulate cacmin-bot live writes — update them with any contract change.
3. Update this doc **and**
   `telegram-chat-explorer/dev-docs/integration-cacmin-bot.md` together.
4. The driver is `src/sqlite.ts`: `bun:sqlite` in production (the bot runs under
   Bun), `better-sqlite3` only as the Vitest/Node fallback.
