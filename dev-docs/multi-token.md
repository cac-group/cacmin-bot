# Multi-token ledger

The bot supports JUNO on Juno and CAC on Osmosis. Tokens are defined in
`src/tokens.ts`; the denom is the ledger key everywhere.

## Data model

- `user_balances` is keyed by `(user_id, denom)`. Migration 018 rebuilt the old
  one-row-per-user table and copied existing balances as `ujuno`.
- `transactions.denom` records the token for every ledger entry.
- `processed_deposits` carries `denom` and `network` (`juno` / `osmosis`).
  Deposit watermarks are separate per network because heights are unrelated.
- `LedgerService` methods default to `ujuno`; pass a denom only for CAC. This is
  why every existing economy command keeps operating on JUNO unchanged.

## Addresses

- JUNO uses `USER_FUNDS_ADDRESS` (or `BOT_TREASURY_ADDRESS` for the treasury).
- CAC uses the **same mnemonic/key as JUNO**, derived with the `osmo` prefix.
  There is no separate Osmosis address setting. The derived address is logged on
  startup; fund it with OSMO for withdrawal gas.

## Chain transport (gRPC only)

`src/services/cosmosGrpcService.ts` is the shared client. It connects with
`@grpc/grpc-js` and the generated `cosmjs-types` services:

- `JunoGrpcService` → `JUNO_GRPC_URL` (default
  `juno-grpc.polkachu.com:12690`, plaintext).
- `OsmosisGrpcService` → `OSMOSIS_GRPC_URL` (default
  `osmosis-grpc.polkachu.com:12590`, plaintext).

Each client performs:

- `cosmos.bank.v1beta1.Query/Balance` for reads;
- `cosmos.tx.v1beta1.Service/GetTx` for hash verification;
- `cosmos.tx.v1beta1.Service/GetTxsEvent` (`query:
  "transfer.recipient='…' AND tx.height >= …"`) for deposit polling;
- `cosmos.auth.v1beta1.Query/Account` plus local `SIGN_MODE_DIRECT` signing and
  `Service/BroadcastTx` (`BROADCAST_MODE_SYNC`) for withdrawals.

There is deliberately **no** REST, LCD, or Tendermint-RPC path for either
chain. Do not add one for a fallback.

## Commands

- `/balance` shows both tokens.
- `/deposit [juno|cac]`
- `/verifydeposit <txhash> [juno|cac]`
- `/claimdeposit <txhash> [juno|cac]`
- `/processdeposit <txhash> [user] [juno|cac]`
- `/withdraw <amount> <address> [juno|cac]`
- `/send <amount> <recipient> [juno|cac]`

JUNO is always the default when the token argument is omitted. CAC withdrawals
have no internal network fee; the bot pays Osmosis gas in uosmo.

## First CAC scan

A brand-new CAC deployment has no deposit watermark. On startup the bot seeds
`system_state.osmosis_deposit_start_height` to the current chain tip instead of
sweeping history, so pre-existing deposits are not auto-credited. Use
`/processdeposit <txhash> [user] cac` for those. If the tip cannot be read, CAC
scanning stays disabled until a later restart can seed it.

CAC deposits must arrive on Osmosis as the native tokenfactory denom. An
IBC-wrapped CAC denom on another chain is not credited automatically.

## Operational checks

- Startup logs `Osmosis gRPC service initialized` with the derived address and
  `hasSigningCapability`.
- A CAC withdrawal fails cleanly if the Osmosis wallet has no OSMO for gas and
  refunds the internal debit.
- `/walletstats` and `/reconcile` remain JUNO-denominated; CAC reconciliation is
  not yet wired into those owner diagnostics.
