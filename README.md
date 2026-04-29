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
yarn install
cp .env.example .env
# Edit .env with required configuration
yarn setup-db
./rebuild.sh          # Production
./rebuild.sh --dev    # Development
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

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment documentation.

### Manual Build

```bash
yarn install && yarn build
sudo ./install.sh
```

### Service Management

```bash
sudo systemctl status cacmin-bot
sudo systemctl restart cacmin-bot
sudo journalctl -u cacmin-bot -f
```

## Commands

Use `/help` in a DM with the bot for a comprehensive, role-based command reference.

### Wallet (All Users)
- `/balance` - View your balance
- `/deposit` - Get deposit address and memo
- `/send <user> <amount>` - Internal transfer
- `/withdraw <address> <amount>` - Withdraw to external wallet
- `/transactions` - View transaction history

### Giveaways (All Users)
- `/giveaway <amount>` - Create open giveaway (funded from your balance)
- `/cancelgiveaway <id>` - Cancel your giveaway (unclaimed funds returned)

### Moderation (Admin+)
- `/jail <user> <minutes>` - Temporarily mute user
- `/unjail <user>` - Release user from jail
- `/warn <user> <reason>` - Issue warning
- `/addrestriction <user> <type>` - Add content restriction, including `random_delete` with a chance like `10%`
- `/addblacklist <user>` - Add to blacklist
- `/addwhitelist <user>` - Add to whitelist
- `/regexhelp` - Regex pattern guide

### Treasury (Owner Only)
- `/botbalance` - On-chain wallet balance
- `/treasury` - Treasury and ledger overview
- `/walletstats` - Detailed reconciliation stats
- `/reconcile` - Force balance reconciliation
- `/processdeposit` - Manually process unclaimed deposit

### Role Management (Owner)
- `/setowner <user>` - Transfer ownership
- `/makeadmin <user>` - Promote to admin
- `/elevate <user>` - Promote to elevated
- `/revoke <user>` - Remove role

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
yarn test                    # Run all tests
yarn test:watch              # Watch mode
yarn test:coverage           # Coverage report
yarn test tests/unit         # Unit tests only
yarn test tests/integration  # Integration tests only
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
