# Account Types & ID Ranges

| ID Range     | Type            | Purpose                                               |
| ------------ | --------------- | ----------------------------------------------------- |
| > 0          | User Accounts   | Real Telegram users (ID = Telegram userId)            |
| -1           | BOT_TREASURY    | Collects fines, bail payments, system revenue         |
| -2           | SYSTEM_RESERVE  | Reconciliation adjustments, discrepancy handling      |
| -3           | UNCLAIMED       | Deposits with invalid/missing memo                    |
| -100 to -999 | Shared Accounts | Multi-user or shared wallets (current/future feature) |
| ≤ -1001      | Giveaway Escrow | One per giveaway: `-1000 - giveawayId`                |

---

# On-Chain vs Internal Ledger

```
┌─────────────────────────────────────────────────────────────────┐
│                       ON-CHAIN (Juno Blockchain)                │
│                                                                 │
│   ┌───────────────────────┐                                     │
│   │    BOT_TREASURY_ADDR  │ ← Holds ALL program funds           │
│   │       (juno1...)      │   Mnemonic in env; signs withdrawals│
│   └───────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
          │
          │ Deposits detected via gRPC tx index
          │ Withdrawals signed & broadcast
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     INTERNAL LEDGER (SQLite)                    │
│                                                                 │
│   ┌───────────────┐   ┌────────────────┐   ┌────────────────┐   │
│   │ user_balances │   │ transactions   │   │     users      │   │
│   │(userId,denom,│   │ full audit log │   │ id, role, name │   │
│   │    bal)       │   │  + denom       │   │                │   │
│   └───────────────┘   └────────────────┘   └────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Core principle:**
Each supported token has one on-chain wallet: JUNO on Juno and CAC on
Osmosis. Balances are keyed by `(userId, denom)`, so the same user can hold
JUNO and CAC without the balances mixing. The SQLite ledger is the source of
truth for ownership accounting.

Juno and Osmosis reads and writes use only Polkachu gRPC endpoints;
there is no LCD/REST or Tendermint-RPC fallback.

---

# Fund Flow Diagrams

## 1. Deposits

```
External Wallet ──JUNO──▶ BOT_TREASURY_ADDR
          │
          │ gRPC tx index detects tx
          │ Memo parsed for userId
          ▼
      ┌──────────────────────┐
      │ Valid userId memo?   │
      └──────────────────────┘
           │            │
         YES           NO
           │            │
           ▼            ▼
 User balance credited   UNCLAIMED (-3)
                         (admin can reassign)
```

---

## 2. Withdrawals

```
User requests /withdraw
        ▼
┌────────────────────────┐
│ Balance check           │
│ Transaction lock (mutex)│
└────────────────────────┘
        │
        ▼
Internal balance debited
        ▼
On-chain tx signed & broadcast
        ▼
Funds arrive in user's external address
```

---

## 3. Internal Transfers (User → User)

```
User A ──/send 10 @userB──▶ LedgerService.transferBetweenUsers()
         │
         ▼
   ┌─────────────────┐
   │ A.balance ≥ 10? │
   └─────────────────┘
         │
        YES
         │
         ▼
 A.balance -= 10
 B.balance += 10
 transactions record created

(No on-chain activity. Instant. Free.)
```

---

## 4. Giveaways (New System)

```
/giveaway 100 (10 slots)
        ▼
Balance check
        ▼
Create giveaway (ID = 1)
        ▼
Create escrow account (ID = -1001)
        ▼
Transfer 100 → Escrow(-1001)
        ▼
┌─────────────────────────────────────────┐
│            GIVEAWAY ACTIVE              │
│ Escrow -1001 holds 100 JUNO             │
│ 10 slots × 10 JUNO each                 │
└─────────────────────────────────────────┘
   │                         │
   │ User claims             │ Cancel
   ▼                         ▼
10 from Escrow → User     Remaining → Funder
```

---

## 5. Fines & Bail

```
Violation detected
        ▼
User jailed (bail = X)
        ▼
/paybail or /bail @user
        ▼
Balance check (payer ≥ X)
        ▼
Payer.balance -= X
BOT_TREASURY.balance += X
User unjailed
```

---

# Access Control Matrix

| Operation          | Who Can Do It     | From            | To               |
| ------------------ | ----------------- | --------------- | ---------------- |
| Deposit            | Anyone (external) | On-chain        | User / UNCLAIMED |
| Withdraw           | Any user          | User            | External address |
| Transfer           | Any user          | User            | User             |
| Create Giveaway    | Any user          | User            | Giveaway Escrow  |
| Create Giveaway    | Owner/Admin       | Treasury/Self   | Giveaway Escrow  |
| Claim Giveaway     | Any user (once)   | Giveaway Escrow | User             |
| Cancel Giveaway    | Creator/Admin     | Giveaway Escrow | Funder           |
| Pay Fine           | Any user          | User            | BOT_TREASURY     |
| Pay Bail           | Any user          | User            | BOT_TREASURY     |
| Claim Unclaimed    | Admin             | UNCLAIMED       | User             |
| Reconciliation Adj | System only       | SYSTEM_RESERVE  | Any              |

---

# Balance Validation Rules

All debit operations enforce:

1. **Sufficient balance** (`fromBalance >= amount`)
2. **No negative balances** ever
3. **Execution-time revalidation** (balance checked again during commit)
4. **Full audit** via `transactions` records

**Exception:**
`SYSTEM_RESERVE` may temporarily go negative during reconciliation.

---

# Database Tables

```
users                # Account registry (positive=real, negative=system)
user_balances        # Current balances
transactions         # Full immutable audit log
giveaways            # Metadata & state
giveaway_claims      # Claim records
processed_deposits   # Ensures idempotent deposit handling
transaction_locks    # Prevents concurrent double-spend
```
