# MarkdownV2 Migration Plan

## Overview
Migrate all Telegram message formatting from legacy Markdown to MarkdownV2 across the entire codebase.

## MarkdownV2 Escaping Rules

### Characters that MUST be escaped (with backslash)
```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

### Special contexts:
- Inside `` `code` `` blocks: Only `` ` `` and `\` need escaping
- Inside ```` ```pre``` ```` blocks: Only `` ` `` and `\` need escaping
- Inside inline links `[text](url)`: `)` and `\` need escaping in URL

### Format comparison:
| Feature | Legacy Markdown | MarkdownV2 |
|---------|----------------|------------|
| Bold | `*text*` | `*text*` |
| Italic | `_text_` | `_text_` |
| Code | `` `text` `` | `` `text` `` |
| Pre | ``` ```text``` ``` | ``` ```text``` ``` |
| Link | `[text](url)` | `[text](url)` |
| Strikethrough | N/A | `~text~` |
| Underline | N/A | `__text__` |
| Spoiler | N/A | `\|\|text\|\|` |

## Files to Migrate

### Priority 1: Handlers (3 files)
- [ ] `src/handlers/callbacks.ts` - 14 occurrences
- [ ] `src/handlers/wallet.ts` - 25+ occurrences
- [ ] `src/handlers/restrictions.ts` - 3 occurrences

### Priority 2: Commands (8 files)
- [ ] `src/commands/giveaway.ts` - 6 occurrences
- [ ] `src/commands/moderation.ts` - 2 occurrences
- [ ] `src/commands/sharedAccounts.ts` - 18+ occurrences
- [ ] `src/commands/sticker.ts` - 3 occurrences
- [ ] `src/commands/wallet.ts` - 1 occurrence
- [ ] `src/commands/walletTest.ts` - 12+ occurrences
- [ ] `src/commands/deposit.ts` - needs check
- [ ] `src/commands/fineConfig.ts` - needs check

### Priority 3: Services/Middleware/Utils (3 files)
- [ ] `src/services/restrictionService.ts` - 4 occurrences
- [ ] `src/middleware/lockCheck.ts` - 1 occurrence
- [ ] `src/utils/adminNotify.ts` - 1 occurrence

### Already Using MarkdownV2 (reference)
- `src/commands/help.ts`
- `src/commands/jail.ts` (partial)
- `src/commands/payment.ts` (partial)
- `src/handlers/violations.ts`

## Migration Checklist Per File

For each file:
1. [ ] Add import: `import { escapeMarkdownV2, escapeNumber } from "../utils/markdown";`
2. [ ] Find all `parse_mode: "Markdown"` occurrences
3. [ ] For each message:
   - [ ] Identify static text needing escape (periods, hyphens, parens, etc.)
   - [ ] Identify dynamic variables needing `escapeMarkdownV2()` wrapper
   - [ ] Identify numbers needing `escapeNumber()` wrapper
   - [ ] Update the string content
4. [ ] Change `parse_mode: "Markdown"` to `parse_mode: "MarkdownV2"`
5. [ ] Test the file compiles: `yarn build`
6. [ ] Run tests: `yarn test`

## Common Patterns to Replace

### Static text escaping:
```typescript
// Before (Markdown)
"Hello - World. Test (example)"

// After (MarkdownV2)
"Hello \\- World\\. Test \\(example\\)"
```

### Dynamic content escaping:
```typescript
// Before (Markdown)
`Balance: ${balance} JUNO`

// After (MarkdownV2)
`Balance: ${escapeNumber(balance, 6)} JUNO`

// Before (Markdown)
`User: ${username}`

// After (MarkdownV2)
`User: ${escapeMarkdownV2(username)}`
```

### Numbers with decimals:
```typescript
// Before
`Amount: ${amount.toFixed(6)} JUNO`

// After
`Amount: ${escapeNumber(amount, 6)} JUNO`
```

## Testing Strategy

1. After each file migration:
   - Run `yarn build` to catch syntax errors
   - Run `yarn test` to catch logic errors

2. Manual testing (after all migrations):
   - Test each command type in Telegram
   - Verify special characters render correctly
   - Check that dynamic content displays properly

## Rollback Plan

If issues arise:
1. Each file can be reverted independently via git
2. Keep commits granular (one file per commit)
3. Tag before starting: `git tag pre-markdownv2-migration`

## Progress Tracking

Started: [DATE]
Completed: [DATE]

### File Status:
| File | Import Added | Content Fixed | Parse Mode | Tested |
|------|-------------|---------------|------------|--------|
| callbacks.ts | [ ] | [ ] | [ ] | [ ] |
| wallet.ts (handler) | [ ] | [ ] | [ ] | [ ] |
| restrictions.ts | [ ] | [ ] | [ ] | [ ] |
| giveaway.ts | [ ] | [ ] | [ ] | [ ] |
| moderation.ts | [ ] | [ ] | [ ] | [ ] |
| sharedAccounts.ts | [ ] | [ ] | [ ] | [ ] |
| sticker.ts | [ ] | [ ] | [ ] | [ ] |
| wallet.ts (cmd) | [ ] | [ ] | [ ] | [ ] |
| walletTest.ts | [ ] | [ ] | [ ] | [ ] |
| deposit.ts | [ ] | [ ] | [ ] | [ ] |
| fineConfig.ts | [ ] | [ ] | [ ] | [ ] |
| restrictionService.ts | [ ] | [ ] | [ ] | [ ] |
| lockCheck.ts | [ ] | [ ] | [ ] | [ ] |
| adminNotify.ts | [ ] | [ ] | [ ] | [ ] |
