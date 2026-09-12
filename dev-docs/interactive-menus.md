# Interactive Menus (DM)

Applies to `src/handlers/callbacks.ts`, `src/commands/help.ts`,
`src/commands/helpTree.ts`, `src/commands/rateLimit.ts`,
`src/handlers/spamReacts.ts`, `src/handlers/actions.ts`,
`src/commands/moderation.ts`, `src/commands/duel.ts`, and
`src/utils/menuSession.ts`.

## The one-message rule

A callback-driven flow owns **one** message. Every step edits that message; a
flow never both edits it and posts a second message. When a step needs free
text, the prompt is written into the owned message and its buttons are removed.
When the flow finishes, the result replaces the owned message text and the
buttons stay gone.

- `menuRefFromContext(ctx)` captures `{chatId, messageId}` from a callback.
- `withMenuRef(ctx, data)` stores it in the callback session so later text
  steps can still find the message.
- `editMenu(ctx, ref, text, replyMarkup?)` edits the owned message, defaulting
  to `keyboards.noKeyboard` (`{ inline_keyboard: [] }`) so no stale buttons
  remain. If the message is gone or the update was a text step with no ref, it
  falls back to `ctx.reply`.
- `finishMenu(ctx, session, text)` is `editMenu` with the session's ref.

Callbacks that advance to a *new* button step pass that keyboard to
`editMenu`/`ctx.editMessageText` explicitly (e.g. severity → auto-jail).

## Callback answering

The dispatcher routes callbacks and then answers in a `finally` block. A
handler that calls `answerCbQuery(text)` shows a toast; the dispatcher's later
silent answer is a harmless no-op. This replaced an earlier design that
answered before routing, which swallowed every handler toast and logged errors.
Every callback must still terminate in an answer (the finally guarantees it).

## Entry points

- `/menu` → `mainMenuKeyboard`; `menu_lists` / `menu_roles` open the list and
  role management keyboards (admin/owner only, with a Back button).
- `/help` → role-filtered `helpTree` navigation (edit-based).
- `/addrestriction` (no args) → type → target → severity → auto-jail.
- `/jail` (no args) → `jailDurationKeyboard` → target.
- `/addaction` (no args) → `globalActionKeyboard` → action or "apply".
- `/addspamreact` (no args) → field → pattern.
- `/ratelimitreset` (DM) → window → payment instructions.
- Giveaway/duel buttons → their own flows.

## Permission model

Interactive callbacks re-check the same permission as the command that opened
them: `verifyAdminRole` = owner or admin (not the `elevated` role);
`verifyOwner` for owner-only flows such as spam-react patterns. Role and list
actions additionally gate per action (only owners promote admins). This matches
the `adminOrHigher` / `ownerOnly` middleware on the commands.

## Removed dead code

These were registered but never reachable, or had no initiating flow, and were
deleted: `give_*`/`handleGiveawayCallback` (superseded by `/giveaway`),
`durationKeyboard`/`duration_*`, `sharedPermissionKeyboard`/`perm_*`,
`confirmationKeyboard`/`confirm_*`, `select_user_*`, and `giveawaySlotKeyboard`.
The role and list flows were instead wired to `/menu` (`menu_roles`,
`menu_lists`).
