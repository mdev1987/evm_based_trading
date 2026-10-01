# EVM Based Trading Bot — v2.0.0

Bun + TypeScript paper/live trading engine for EVM chains.

The current v2.0.0 runtime is intentionally small:

```text
Debot AI Rank
     │
     ▼
 Signal coordinator
     │
     ▼
 TradingEngine ───────────────┐
     │                         │
     ├── 0x WDK quotes         │
     ├── strategy / TP / trail │
     ├── wallet accounting     │
     └── lowdb state            │
                               │
DexScreener ── price tracking ┘
                               │
Telegram ── reporting ────────┘
```

## What v2.0.0 supports

- **Paper mode** with configurable virtual balances.
- **Live mode** using a BIP-39 mnemonic through `@tetherto/wdk-wallet-evm`.
- **Arc** (`5042`) and **Robinhood Chain** (`4663`) enabled by default.
- **Debot AI Rank** as a signal source (community rank + dashboard ranks POST).
- **DexPaprika SDK new-pools feed** as a parallel signal source; each chain
  runs any combination of `community`, `dashboard`, `dexpaprika`, and every
  trade message is labeled with its feed (`📡 Source:`) for comparison.
- **DexScreener REST** for price tracking, with up to 30 token addresses per request.
- **0x Swap API v2 through the WDK 0x module** for indicative quotes and live execution.
- Partial take profit and trailing stop logic.
- Per-chain persistent state in `.data/<mode>/`.
- Telegram trade, lifecycle and optional periodic status reports.
- No RxJS, EventEmitter library, Redux-style store, Docker, database server, or background worker framework.

The bot currently **accepts every valid Debot Rank signal**. Candidate filtering is intentionally left as a later strategy module.

## Chain model

| Chain | ID | Trading base | Gas asset | Default mode |
|---|---:|---|---|---|
| Arc | 5042 | Native USDC | USDC | Enabled |
| Robinhood Chain | 4663 | WETH | ETH | Enabled |

On Arc, USDC is both the native gas asset and the native trading balance, so the same balance is exposed as both `baseRaw` and `nativeRaw`. The 0x native-token sentinel is used for the native asset.

Robinhood Chain uses native ETH for gas. 0x currently lists Robinhood Chain (`4663`) and Arc (`5042`) as supported by the Swap API.

The default RPCs are public endpoints. For live production use, set chain-specific private/provider RPC URLs in `.env` rather than relying on public endpoints.

## Important 0x execution safety

The live path uses the WDK 0x protocol module. The module's documented flow is:

1. create a quote-only protocol without a wallet when a wallet is not needed;
2. create a wallet-bound protocol for execution;
3. call `swidge()` for the real swap;
4. poll `getSwidgeStatus()` against on-chain transaction state.

The application does **not** construct a Settler approval. The WDK 0x module performs the supported ERC-20 approval flow, and 0x documents that approvals must use the spender returned by the API / supported approval mechanism rather than the Settler contract.

The upstream WDK 0x package also notes that its examples are not audited and that its current mainnet verification is documented on Base; therefore v2.0.0 should be tested with small live amounts on each target chain before production capital is used.

## Installation

Bun 1.4+ is recommended.

```bash
bun install
cp .env.example .env
```

Set at least:

```dotenv
MODE=paper
CHAINS=ARC,Robinhood
ZERO_EX_API_KEY=your_0x_key
```

Run:

```bash
bun run main.ts
```

Or use the package script:

```bash
bun run start
```

Type-check:

```bash
bun run typecheck
```

Tests:

```bash
bun test
```

Run the full local check:

```bash
bun run check
```

## Paper mode

Paper mode never loads a private key and never submits a blockchain transaction.

The bot still obtains live 0x indicative quotes, so a paper entry can be skipped when 0x has no route/liquidity or exceeds the configured fee limits.

Example defaults:

```dotenv
MODE=paper
CHAINS=ARC,Robinhood
PAPER_INITIAL_BASE=1
PAPER_INITIAL_NATIVE=0.01
BUY_AMOUNT_BASE=0.1
MAX_OPEN_POSITIONS=3
```

`PAPER_INITIAL_NATIVE` is ignored on Arc because native USDC is the same balance as the trading base.

Paper state is stored independently for each chain:

```text
.data/paper/arc.json
.data/paper/robinhood.json
```

## Live mode

Live mode requires an explicit confirmation switch as well as the mnemonic:

```dotenv
MODE=live
LIVE_TRADING_CONFIRM=YES
MNEMONIC=your twelve or twenty-four word seed phrase
WALLET_ACCOUNT_INDEX=0
```

The wallet service creates one WDK manager/account per enabled chain and never writes the mnemonic into state files or Telegram messages.

Live state is separated from paper state:

```text
.data/live/arc.json
.data/live/robinhood.json
```

Before using live mode:

- fund the wallet with the configured trading base;
- fund native gas where the base asset is not native (Robinhood ETH);
- verify the account address printed at startup;
- use a small amount first;
- monitor the first few transactions on the chain explorer.

The WDK EVM wallet package is currently published as a beta package, so the README for the dependency itself recommends thorough development testing before production use.

## Strategy defaults

The strategy is entirely environment-driven:

```dotenv
TAKE_PROFIT_LEVELS=25:50,100:50
TRAILING_ACTIVATION_PERCENT=25
TRAILING_DISTANCE_PERCENT=10
STOP_LOSS_PERCENT=25
# Stale reaper: paper positions with no price update this long are written to
# $0 (dead pool; live never force-closes); 0 disables.
STALE_TIMEOUT_MS=10800000
```

This means:

- +25%: sell 50% of the remaining position.
- +100%: sell 50% of the remainder, leaving a runner to the trailing stop.
- +25%: trailing stop becomes active.
- Trailing distance: 10% below the highest observed price.
- −25%: hard stop-loss, full exit via the 0x sell-quote path.
- 3h without a price update: paper writes the position to $0 (dead pool; live holds).

The values are examples/defaults, not a performance claim.

## Signal and price lifecycle

Each enabled chain runs independently:

```text
Debot Rank poll
    ↓
normalize/validate signal
    ↓
re-entry cooldown
    ↓
0x indicative quote
    ↓
balance/gas preflight
    ↓
paper position OR live swap
    ↓
track token with DexScreener
    ↓
price update
    ↓
TP / trailing evaluation
    ↓
0x sell quote / live swap
    ↓
state + Telegram
```

A token remains price-tracked while it is a fresh signal or an open position. Expired signal-only tokens are removed automatically.

DexScreener's token endpoint accepts multiple comma-separated token addresses, up to 30 per request, with the documented 300 requests/minute limit. The default two-second interval therefore stays well below the documented request ceiling when using one batch.

## Live accounting

The live engine does not assume the quote output is the actual fill.

While a submitted swap is still pending, scheduled wallet synchronization does not overwrite the position ledger. Terminal settlement then records the observed wallet deltas.

For buys it reconciles:

- token balance before the swap;
- token balance after the swap;
- base balance before/after;
- native gas balance before/after.

For sells it reconciles the actual token balance reduction and the actual base balance increase. Gas is recorded separately.

This is important because an indicative quote is not a trade receipt.

## PnL

The state tracks:

- realized trading PnL in the configured base asset;
- unrealized PnL from the latest DexScreener price;
- native network fees;
- net PnL = realized + unrealized − network fees converted with the configured `*_NATIVE_TO_BASE_RATE`;
- equity;
- peak equity;
- maximum drawdown;
- wins/losses and win rate.

The native-to-base conversion is a configurable accounting display rate. It is not an external price oracle.

## Telegram

Telegram reporting is optional:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:replace_me
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_STATUS_ENABLED=false
```

Lifecycle and trade messages identify the chain, for example:

```text
Arc — BUY
Mode: PAPER
...

Robinhood Chain — BUY
Mode: LIVE
...
```

Startup and periodic status reports also include the complete enabled-chain list, so a multi-chain deployment is explicit in the chat.

The bot does not start Telegram long polling; it only sends outbound reports. Startup, shutdown, status, error, entry, exit and pending-transaction messages include chain context. Multi-chain startup/status messages list the active enabled chains rather than failed startup chains.

`grammy` is the Telegram transport and `telegram-markdown-v2` converts normal Markdown into Telegram MarkdownV2.

## Configuration

All operational tuning is in `.env`.

### Global runtime

```dotenv
MODE=paper
CHAINS=ARC,Robinhood
STATE_DIR=.data
WALLET_ACCOUNT_INDEX=0
LIVE_TRADING_CONFIRM=YES
```

### Paper/risk

```dotenv
PAPER_INITIAL_BASE=1
PAPER_INITIAL_NATIVE=0.01
BUY_AMOUNT_BASE=0.1
MAX_OPEN_POSITIONS=3
SIGNAL_REENTRY_COOLDOWN_MS=21600000
MAX_DAILY_LOSS_PCT=20
```

### Strategy

```dotenv
TAKE_PROFIT_LEVELS=25:50,100:50
TRAILING_ACTIVATION_PERCENT=25
TRAILING_DISTANCE_PERCENT=10
# Time-stop: full exit via the 0x sell-quote path after holding this long (ms); 0 disables.
# Paper and live both require a quotable route and pay the quoted network fee.
TIME_STOP_MS=86400000
# Stale reaper: paper positions with no price update this long are written to
# $0 (dead pool; live never force-closes); 0 disables.
STALE_TIMEOUT_MS=10800000
```

### Debot

```dotenv
DEBOT_DURATION=1m
DEBOT_LIMIT=10
DEBOT_POLL_INTERVAL_MS=30000
DEBOT_TIMEOUT_MS=10000
```

### DexScreener

```dotenv
DEXSCREENER_INTERVAL_MS=2000
DEXSCREENER_TIMEOUT_MS=10000
DEXSCREENER_MAX_ADDRESSES=30
TRACKED_TOKEN_TTL_MS=600000
LOG_PRICES=false
```

### 0x

```dotenv
ZERO_EX_API_KEY=
ZERO_EX_BASE_URL=https://api.0x.org
ZERO_EX_DEFAULT_SLIPPAGE=0.005
ZERO_EX_MAX_NETWORK_FEE_BPS=100
ZERO_EX_MAX_PROTOCOL_FEE_BPS=100
ZERO_EX_SKIP_APPROVAL=false
```

### Live execution

```dotenv
EXECUTION_POLL_INTERVAL_MS=3000
EXECUTION_TIMEOUT_MS=120000
STATUS_INTERVAL_MS=10000
```

### Chain overrides

Every enabled chain has environment overrides for:

```text
RPC_URL
SIGNAL_SOURCES            # comma list: community, dashboard, dexpaprika
DEBOT_CHAIN               # community rank chain id
DEBOT_COLUMN              # dashboard ranks column (e.g. new)
DEBOT_MEME_TYPES          # dashboard launchpad types (required for dashboard)
DEXSCREENER_CHAIN
DEXPAPRIKA_NETWORK        # SDK pools + USD pricing network id
BASE_TOKEN
BASE_SYMBOL
BASE_DECIMALS
BASE_IS_NATIVE
NATIVE_SYMBOL
NATIVE_DECIMALS
NATIVE_TO_BASE_RATE
EXPLORER_URL
MIN_LIQUIDITY_USD
MIN_VOLUME_USD_24H
MIN_TXNS_24H
ALLOW_UNVERIFIED_SNAPSHOT
MOMENTUM_OVERRIDE         # 1h rockets waive the volume bar (pools feed only)
MOMENTUM_MIN_GAIN_PCT
MOMENTUM_MIN_LIQ_USD
```

For Arc the variables are prefixed `ARC_`. For Robinhood Chain they are prefixed `ROBINHOOD_`.

See `.env.example` for the complete reference file.

## File layout

```text
.
├── engine/
│   ├── engine.ts       # serialized trading/accounting engine
│   ├── store.ts        # lowdb state + migration/repair
│   ├── strategy.ts     # pure entry/exit rules
│   └── types.ts        # normalized domain types
├── services/
│   ├── config.ts       # complete environment configuration
│   ├── debot_ai.ts     # Debot Rank client
│   ├── dexscreener.ts  # batched price polling
│   ├── telegram.ts     # outbound Telegram reporting
│   ├── wallet.ts       # live WDK wallet service
│   └── zero_ex.ts      # 0x quote + live swap boundary
├── main.ts
├── .env.example
├── package.json
├── CHANGELOG.md
├── SECURITY.md
├── RELEASE_AUDIT.md
└── README.md
```

## State recovery

The state loader is defensive against malformed JSON fields and signed PnL values. This prevents a corrupted/missing `balanceNativeRaw` or a negative realized-PnL value from reaching `BigInt()` in an invalid form during startup or reporting.

State is stored per mode and per chain to prevent accidental reuse of paper positions in live trading.

For a clean paper run, stop the bot and remove `.data/paper/`.

Do **not** delete live state casually; it is the recovery record for open positions.

## Live transaction recovery

Every live submission is written to a per-chain pending-swap journal before confirmation is awaited. If confirmation exceeds `EXECUTION_TIMEOUT_MS`, the transaction is **not forgotten** and the token is blocked from duplicate entry/exit while it remains pending. On the next startup and during live status cycles, the engine asks 0x/WDK for the transaction status and reconciles wallet deltas only after a terminal state is observed.

For native-base chains such as Arc, realized PnL uses the actual base-wallet delta for exits and network gas is not subtracted a second time. For ERC-20-base chains such as Robinhood, native gas is tracked separately and converted with the configured accounting rate.

## Production checklist

1. Copy `.env.example` to `.env`.
2. Set a real 0x API key.
3. Set `CHAINS` explicitly for the deployment.
4. Use trusted RPC endpoints for live wallets.
5. Verify wallet addresses at startup.
6. Start in paper mode and confirm the signal → quote → price → TP/trailing lifecycle.
7. Run live with a very small position size first.
8. Confirm approvals and swaps on-chain.
9. Keep `ZERO_EX_SKIP_APPROVAL=false` unless the wallet is already intentionally approved and the risk is understood.
10. Back up live state before operational changes.

## Scope deliberately excluded from v2.0.0

- Automatic candidate filtering beyond accepting Debot Rank signals.
- Historical market-data/research warehouse (the bot does keep a trade/exit/skip
  analytics database in `.data/history.duckdb` plus log-backfill scripts;
  raw market-data archiving is what's excluded).
- Wallet/KOL labeling.
- Prometheus/Grafana.
- Web UI.
- Automatic RPC failover.
- Historical market-data storage.

Same-chain transaction timeout/restart recovery **is included** through the persistent pending-swap journal. The bot still requires manual operational review when wallet reconciliation cannot be completed automatically.

## Dependency notes

The project pins the direct runtime dependency versions in `package.json` for reproducibility. Run `bun install` after obtaining the repository so Bun generates the lockfile for the exact dependency set.

Current direct runtime versions used by v2.0.0 include `grammy` 1.46.0, `telegram-markdown-v2` 0.0.5, and `@tetherto/wdk-wallet-evm` 1.0.0-beta.19. The WDK EVM wallet package is a beta dependency; live use should therefore be introduced gradually and tested on the exact target chains.

Reference documentation:

- [0x Supported Chains](https://docs.0x.org/docs/introduction/supported-chains)
- [0x API Overview](https://docs.0x.org/api-reference/api-overview)
- [0x WDK protocol module](https://github.com/0xProject/wdk-protocol-swidge-0x)
- [DexScreener API](https://docs.dexscreener.com/api/reference)
- [grammy](https://www.npmjs.com/package/grammy)
- [telegram-markdown-v2](https://www.npmjs.com/package/telegram-markdown-v2)
- [@tetherto/wdk-wallet-evm](https://www.npmjs.com/package/@tetherto/wdk-wallet-evm)
