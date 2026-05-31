# CAC Admin Bot

Cosmos Airdrops Chat administration bot built with [Telegraf](https://telegraf.js.org/) in TypeScript. Combines advanced moderation features with a unified wallet system for JUNO cryptocurrency, using an internal ledger architecture backed by SQLite.

## Features

### Role Management
- **Four-tier role hierarchy**: `owner` > `admin` > `elevated` > `pleb`
- **Owner**: Full control including wallet/treasury access, role promotions, bot configuration
- **Admin**: Moderation powers (jail, restrictions, blacklist) but NO access to funds, treasury, or config
- **Elevated**: Basic user with wallet access, can view lists and statistics
- **Pleb**: Default role for all users

### Unified Wallet System
- Single JUNO wallet with internal ledger for all users
- Automatic deposit detection via RPC monitoring with memo-based routing
- Instant, fee-free internal transfers between users
- Secure withdrawal flow with transaction locking
- Complete audit trail of all financial operations
- See [LEDGER.md](LEDGER.md) for technical details
- See [ADMIN_MANUAL.md](ADMIN_MANUAL.md) for operational documentation

### Open Giveaway System
- Any user can create giveaways funded from their own balance
- Owners/admins can fund giveaways from treasury
- Configurable slot counts (10, 25, 50, 100 users)
- Users claim slots via inline button
- Per-giveaway escrow accounts for fund isolation
- Creators can cancel and reclaim unclaimed funds

### Content Moderation
- **User Restrictions**: Block specific users from stickers, URLs, media, regex patterns, or chance-based random deletes
- **Global Restrictions**: Apply content rules to all non-elevated users
- **Jail System**: Temporary mutes with configurable duration and bail payments
- **Safe Regex**: Timeout-protected pattern matching prevents ReDoS attacks
- See [REGEX_PATTERNS.md](REGEX_PATTERNS.md) for pattern examples

### Violation Tracking
- Log user violations with configurable penalties
- Fine system with USD-to-JUNO conversion
- Bail payments for early jail release

## Installation

```bash
git clone <repo-url> && cd cacmin-bot
bun install
cp .env.example .env
# Edit .env with required configuration
bun run setup-db
bun run build
bun run dev           # Development
```

**Required Environment Variables:**
- `BOT_TOKEN`: Telegram Bot API token
- `OWNER_ID`: Primary owner Telegram user ID
- `BOT_TREASURY_ADDRESS`: Juno wallet address
- `BOT_TREASURY_MNEMONIC`: Wallet seed phrase (24 words)
- `JUNO_RPC_URL`: Primary Juno RPC endpoint

**Rebuild Options:** `./rebuild.sh [--dev|--quick|--full]`

## Production Deployment

### GitHub Release (Recommended)

```bash
wget https://github.com/cac-group/cacmin-bot/releases/latest/download/cacmin-bot-dist.tar.gz
tar -xzf cacmin-bot-dist.tar.gz
sudo ./install.sh
```

The installer creates a systemd service at `/opt/cacmin-bot` with proper permissions.
Production runs under Bun; install Bun before running `install.sh` if it is not already available on the host.

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment documentation.

### Manual Build

```bash
bun install && bun run build
sudo ./install.sh
```

### Service Management

```bash
sudo systemctl status cacmin-bot
sudo systemctl restart cacmin-bot
sudo journalctl -u cacmin-bot -f
```

## Commands

Use `/help` in a DM with the bot for the interactive, role-based reference. The list below is the full current slash-command surface.

### Core Help
- `/help` - Open the DM help menu
- `/wallethelp` - Show detailed wallet and treasury help

### Wallet and Deposits (All Users unless noted)
- `/balance` or `/bal` - View your internal JUNO balance
- `/deposit` - Get your deposit address and required memo
- `/verifydeposit <txhash>` - Verify and credit a deposit by transaction hash
- `/withdraw <amount> <junoAddress>` - Withdraw JUNO to an external wallet
- `/send <amount> <recipient>` or `/transfer <amount> <recipient>` - Send to `@username`, user ID, or `juno1...` address
- `/transactions [@user|userId]` or `/history [@user|userId]` - View your recent transactions; owners can target another user
- `/checkdeposit <txhash>` or `/checktx <txhash>` - Check whether a deposit was already processed
- `/unclaimeddeposits` - View the current UNCLAIMED deposit pool and recent invalid-memo deposits
- `/fundtreasury <amount>` - Move funds from your balance into the game treasury
- `/fundtreasury deposit` - Get external deposit instructions for the game treasury
- `/treasurybalance` or `/gamebalance` - View the game treasury balance (`admin+`)
- `/contributetreasury <amount>` - Contribute to the treasury from your balance (`admin+`)
- `/withdrawtreasury <amount>` - Withdraw treasury funds back to your balance (`owner`)

### Shared Accounts
- `/createshared <name> <display_name> [description]` - Create a shared account; quote multi-word display names or descriptions (`elevated+`)
- `/listshared` - List all shared accounts (`elevated+`)
- `/myshared` - List the shared accounts you can access
- `/sharedbalance <account>` - View a shared account balance
- `/sharedinfo <account>` - View account metadata and member permissions
- `/sharedsend <account> <@username|user_id> <amount> [description]` - Send from a shared account to another bot user
- `/shareddeposit <account> <amount>` - Move funds from your balance into a shared account
- `/sharedhistory <account> [limit]` - View shared-account transaction history
- `/grantaccess <account_name> <@username|user_id> <level> [spend_limit]` - Grant shared-account access
- `/revokeaccess <account_name> <@username|user_id>` - Remove shared-account access
- `/updateaccess <account_name> <@username|user_id> <level> [spend_limit]` - Change a member's access level
- `/deleteshared <account>` - Delete an empty shared account

### User Status and Visibility
- `/mystatus` - View your role, warnings, jail state, and restrictions
- `/jails` - View currently jailed users
- `/violations` - View your violation history
- `/viewwhitelist` - View whitelisted users
- `/viewblacklist` - View blacklisted users
- `/viewactions` - View active global restrictions
- `/listadmins` - View all elevated, admin, and owner users (`elevated+`)
- `/jailstats [@user|userId]` - View active jail info or a specific user's jail history (`elevated+`)

### Stickers
- `/cac` - Send the first sticker from the CACGifs pack
- `/sendsticker [name]` - Send a named sticker from the pack
- `/getsticker` - Reply to a sticker to get its `file_id`

### Giveaways and Games
- `/giveaway <amount>` - Create an open giveaway funded from your balance
- `/cancelgiveaway [id]` - Cancel one of your active giveaways
- `/roll <amount>` - Play the roll game
- `/rollstats` - View your roll-game statistics
- `/rollodds` - View roll-game rules and probabilities
- `/duel <@username|userId> <amount>` - Challenge another user to a wagered duel
- `/duelstats` - View your duel stats
- `/duelhistory [limit]` - View your recent completed duels
- `/duelcancel` - Cancel your pending outgoing duel

### Payments, Bail, and Verification
- `/payfines` - View all unpaid fines in DM
- `/payallfines` - Pay all unpaid fines from your internal wallet in DM
- `/payfine [violationId]` - List unpaid fines, or show payment instructions for one fine
- `/verifypayment <violationId> <txhash>` - Verify an on-chain fine payment
- `/paybail` - Pay your own bail from wallet balance
- `/paybailfor <@username|userId>` - Pay another user's bail from your wallet
- `/verifybail <txhash>` - Verify your on-chain bail payment
- `/verifybailfor <@username|userId> <txhash>` - Verify an on-chain bail payment made for another user

### Moderation and Restrictions
- `/jail <@username|userId> <minutes>` or `/silence <@username|userId> <minutes>` - Jail a user for a fixed duration (`admin+`)
- `/unjail <@username|userId>` or `/unsilence <@username|userId>` - Release a jailed user (`admin+`)
- `/warn <@username|userId> <reason>` - Issue a warning and violation (`admin+`)
- `/addrestriction <@username|userId> <type> [action] [until] [severity] [threshold] [jailDuration] [jailFine]` - Add a user restriction (`admin+`)
- `/listrestrictions <@username|userId>` - View a user's restrictions (`elevated+`)
- `/removerestriction <@username|userId> [type]` - Remove one restriction, or omit `[type]` to remove them all (`elevated+`)
- `/clearrestrictions <@username|userId>` - Remove all restrictions from a user (`elevated+`)
- `/regexhelp` - Show regex restriction examples (`admin+`)
- `/addaction <restriction> [restrictedAction]` - Add a global restriction (`admin+`)
- `/removeaction <restriction>` - Remove a global restriction (`admin+`)
- `/addwhitelist <@username|userId>` and `/removewhitelist <@username|userId>` - Manage whitelist entries (`admin+`)
- `/addblacklist <@username|userId>` and `/removeblacklist <@username|userId>` - Manage blacklist entries (`admin+`)

### Deposit Recovery and Treasury Ops
- `/claimdeposit <txhash> <userId|@username>` - Assign an unclaimed deposit to a user (`admin+`)
- `/processdeposit <txhash>` - Manually process a deposit that already has a valid memo (`admin+`)
- `/botbalance` - View the bot's on-chain wallet balance (`owner`)
- `/treasury` - View treasury and ledger status (`owner`)
- `/walletstats` - View wallet and reconciliation stats (`owner`)
- `/reconcile` - Force a reconciliation check (`owner`)
- `/adjustbalance <amount> <debit|credit> [reason]` - Correct internal ledger drift (`owner`)

### Roles and Ownership
- `/setowner` - Register yourself as owner if your Telegram ID is already configured in `OWNER_ID/OWNER_IDs`
- `/grantowner <@username|userId>` - Grant owner privileges to another user (`owner`)
- `/makeadmin <@username|userId>` - Promote a user to admin (`owner`)
- `/elevate <@username|userId>` - Promote a user to elevated (`admin+`)
- `/revoke <@username|userId>` - Demote an elevated or admin user (`admin+`)

### Fines and Custom Punishments
- `/setfine <type> <amount_usd> [description]` - Configure a violation fine (`owner`)
- `/listfines` - View fine configuration (`owner`)
- `/initfines` - Seed default fine configuration (`owner`)
- `/customjail <@username|userId> <minutes> <juno_amount> <reason>` - Jail a user with a custom fine (`owner`)
- `/junoprice` - View the current JUNO price (`owner`)
- `/clearviolations <@username|userId>` - Clear all violations for a user (`owner`)
- `/stats` - View overall bot statistics (`owner`)

### Spam-Reaction Pattern Controls
- `/listspamreacts` - View active custom spam-reaction patterns plus built-ins (`admin+`)
- `/spamreacthelp` - Show the spam-reaction field and pattern guide (`admin+`)
- `/addspamreact [pattern] [bio|channel|both]` - Add a custom spam-reaction pattern (`owner`)
- `/removespamreact <id>` - Remove a custom spam-reaction pattern (`owner`)
- `/testspamreact <pattern> <sample>` - Test a spam-reaction pattern without saving it (`owner`)

### Identity Block Pattern Controls
- `/listidentityblocks` - View active name and username block patterns plus built-ins (`admin+`)
- `/identityblockhelp` - Show the identity-block field and pattern guide (`admin+`)
- `/addidentityblock <pattern> [name|username|both]` - Add a custom identity block pattern (`owner`)
- `/removeidentityblock <id>` - Remove a custom identity block pattern (`owner`)
- `/testidentityblock <pattern> <sample>` - Test an identity block pattern without saving it (`owner`)

### Wallet Test Commands (`owner`)
- `/testbalance` - Check your balance and the bot treasury balance
- `/testdeposit` - Show the raw deposit address and memo generated for you
- `/testtransfer <toUserId> <amount>` - Run a direct internal transfer test
- `/testfine [amount]` - Run a fine-payment test
- `/testwithdraw <address> <amount>` - Run a dry-run withdrawal validation
- `/testverify <txhash>` - Test on-chain transaction verification
- `/testwalletstats` - Dump diagnostic wallet and reconciliation stats
- `/testsimulatedeposit [userId] [amount]` - Simulate a deposit directly in the ledger
- `/testhistory` - Show a short transaction-history sample
- `/testfullflow` - Run the end-to-end wallet-flow test sequence

## Architecture

```
src/
  bot.ts              # Entry point, handler registration, periodic tasks
  config.ts           # Environment configuration
  database.ts         # SQLite schema and query functions
  commands/           # Command handlers by feature
    giveaway.ts       # Giveaway creation and management
    wallet.ts         # Balance, deposit, withdraw, send
    moderation.ts     # Jail, restrictions, warnings
    roles.ts          # Role management
  handlers/           # Feature-specific handlers
    callbacks.ts      # Inline keyboard callback handlers
    restrictions.ts   # Content filter logic
  services/           # Business logic layer
    ledgerService.ts          # Internal balance operations
    unifiedWalletService.ts   # On-chain wallet operations
    jailService.ts            # Jail/bail management
    transactionLockService.ts # Concurrency control
  middleware/         # Request pipeline
    auth.ts           # User identification
    permissions.ts    # Role-based access control
    messageFilter.ts  # Content restriction enforcement
  utils/              # Shared utilities
    precision.ts      # Cryptocurrency math (6 decimals)
    safeRegex.ts      # Timeout-protected regex
    keyboards.ts      # Inline keyboard builders
```

### Key Patterns

- **Service-oriented**: Stateless services with static methods
- **Double-entry accounting**: Every transaction creates balanced ledger entries
- **Transaction locks**: Prevent double-spending during withdrawals
- **Escrow accounts**: Per-giveaway fund isolation
- **Protobuf parsing**: Structural memo extraction from RPC data

See [LEDGER.md](LEDGER.md) for detailed token flow documentation.

## Testing

```bash
bun run test                    # Run all tests
bun run test:watch              # Watch mode
bun run test:coverage           # Coverage report
bun run test tests/unit         # Unit tests only
bun run test tests/integration  # Integration tests only
```

## Documentation

- [LEDGER.md](LEDGER.md) - Internal ledger and token management system
- [ADMIN_MANUAL.md](ADMIN_MANUAL.md) - Operational guide for administrators
- [DEPLOYMENT.md](DEPLOYMENT.md) - Production deployment instructions
- [REGEX_PATTERNS.md](REGEX_PATTERNS.md) - Content filter pattern examples
- [CLAUDE.md](CLAUDE.md) - Development guidelines and codebase reference

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make granular commits with clear messages
4. Open a pull request

## License

MIT License. See `LICENSE` for details.
