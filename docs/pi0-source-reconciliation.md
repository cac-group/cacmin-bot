# Pi0 source reconciliation

This migration started from published `main` at
`22d9e5c3698fef33a38ca1a8405d799c4fbe4631` and compared the preserved dirty
checkout patch from the Pi-era workstation source tree. No environment file,
database, log, or runtime data was inspected for this reconciliation.

## Reconciliation map

| Preserved area | Disposition | Evidence |
| --- | --- | --- |
| `.env.example` embedding ownership and trigger settings | Already upstream | The preserved target blob is exactly the current blob, `9fba3401...`. |
| `src/config.ts` external embedding-worker settings and non-negative parsing | Already upstream | The preserved target blob is exactly the current blob, `0920f096...`. |
| Startup refresh of `dataset_meta` and `live_index_state` | Already upstream and retained | Merged by `551baaf`; focused tests cover stale startup values. |
| Incremental writer counters and duplicate-ID protection | Already upstream and retained | Merged by `551baaf`; the current test proves a duplicate does not advance counters. |
| Embedding candidate trigger and pending counter | Already upstream and retained | Merged by `551baaf`; the current test covers thresholding, duplicate delivery, and reset. |
| Media success/error counters | Already upstream and retained | Present in the current writer implementation from `551baaf`. |
| README single-writer/embedding topology | Already upstream, expanded here | The current README already contained the preserved text; this migration adds the `tgbot` ownership and recovery contract. |
| Live message identity and reaction indexing | Ported upstream after the preserved patch | `551baaf` introduced interaction indexing; `2558cbf` rejects stale reaction updates and `1d912fd` hardens identity/edit/reaction behavior. |
| Duplicate message identity retry | Ported upstream after the preserved patch | `1d912fd` keeps identity maintenance active even when the canonical message row already exists. |
| Shared SQLite write contention | Ported upstream after the preserved patch | `728b17e` configures and tests a 30-second busy timeout for both writers. |
| Canonical live message source | Ported upstream after the preserved patch | `4624001` preserves the single writer's canonical source label. |
| Preserved test additions | Already upstream and extended | Current focused suites also cover edits, vector invalidation, multi-reaction state, stale updates, mentions, and identity history. |
| `.codex` and `.serena/*` untracked entries | Obsolete/tool-local | No runtime or deploy behavior; not ported. |

The packaged Pi v2.14.2 archive has the same application version as published
main and includes the compiled interaction-indexer modules represented by the
source commits above. No unique financial, moderation, wallet, writer,
interaction, metrics, or embedding-trigger behavior remained only in the
packaged build or preserved dirty patch.

## Packaged-build evidence

The exact non-secret Pi package is retained on this workstation, not in Git:

- Evidence root: `/home/cordt/backups/pi0-to-tgbot/20260715T223021Z/git/pi0-salvage`
- Backup manifest: `/home/cordt/backups/pi0-to-tgbot/20260715T223021Z/git/pi0-salvage/manifest.md`
- Archive: `cacmin-bot/packaged-source.tar.gz`
- Archive SHA-256: `534e60c4ddd2486d0daca2caa94e3e826c83e0a09a02d9c01e3e66dc23a57597`
- Aggregate checksum record: `artifact-sha256.txt`

The backup manifest records that the archive excludes `.env`, databases,
logs, `node_modules`, and the private Bun home. Validate every member before
extracting into a new temporary directory; do not inspect or source runtime
configuration while reconciling code:

```bash
evidence=/home/cordt/backups/pi0-to-tgbot/20260715T223021Z/git/pi0-salvage
archive="$evidence/cacmin-bot/packaged-source.tar.gz"
sha256sum "$archive"

python3 - "$archive" <<'PY'
import posixpath
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        normalized = posixpath.normpath(member.name)
        unsafe = (
            not member.name
            or member.name.startswith("/")
            or normalized == ".."
            or normalized.startswith("../")
            or member.isdev()
            or member.isfifo()
            or member.issym()
            or member.islnk()
        )
        if unsafe:
            raise SystemExit(f"unsafe archive member: {member.name}")
PY

work=$(mktemp -d /tmp/cacmin-reconcile.XXXXXX)
trap 'rm -rf "$work"' EXIT
tar --extract --gzip --file="$archive" --directory="$work" \
  --no-same-owner --no-same-permissions -- \
  dist/bot.js dist/config.js dist/database.js \
  dist/services/chatIndexerService.js \
  dist/services/chatInteractionIndexerService.js package.json

for module in bot config database \
  services/chatIndexerService services/chatInteractionIndexerService; do
  sha256sum "$work/dist/$module.js" "dist/$module.js"
  cmp --silent "$work/dist/$module.js" "dist/$module.js"
done
```

The reconciliation above was rerun from this migration worktree. Both package
versions were `2.14.2`, the archive manifest passed the safe-member check, and
all five compiled modules were byte-identical:

| Module | Packaged/current SHA-256 | Result |
| --- | --- | --- |
| `dist/bot.js` | `73b01cc80dcd3da1f168ffb8d32035d38ff45c3299c127a4289f79b7b05d4777` | identical |
| `dist/config.js` | `011882dd8803cf6afb7d086c16f1aca895766107a2373675ee39c68205b27e6e` | identical |
| `dist/database.js` | `3d3cd310c1cde9a932482859b908ab97aab5c49e47602710cc0255a6f6aa3028` | identical |
| `dist/services/chatIndexerService.js` | `8a38ab454bd607af3e5c61c19bb7278689fe56b79e8793784a66bb37151b64b8` | identical |
| `dist/services/chatInteractionIndexerService.js` | `6d0d65fdcfb37cc91ef28a802af66186978491467c2ff030e57c9b9ad082455c` | identical |

The corresponding published source module hashes are recorded independently
so a future rebuild can distinguish a changed source tree from compiler-output
drift:

| Source module | SHA-256 |
| --- | --- |
| `src/bot.ts` | `aa96a2a120a50a19cb56da534d9dff9fd40ef63ef83ae0efea5bfefa51bc27f5` |
| `src/config.ts` | `1b8f4a920ab9c2ec50a8b11b24f32c78cedb953be1b84383d4d14d4ea6a6b702` |
| `src/database.ts` | `af2d33e83d1413c6b5fbe505478e87d79936ca5b88468806daba1b9a840f9f24` |
| `src/services/chatIndexerService.ts` | `411d4ba4e67e62badf6b773a9b67714a0b5e7e78ad814cbc6b7b5f11a5a97743` |
| `src/services/chatInteractionIndexerService.ts` | `fc7362aa75b065b870b0b4e2de7f20e6ae6b4515c91f33b863076029dd91124e` |
