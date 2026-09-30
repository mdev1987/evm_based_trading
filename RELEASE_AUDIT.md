# Release Audit — v2.0.0

Date: 2026-09-29

## Scope

This release is the final major 2.0.0 consolidation of the Bun + TypeScript EVM trading bot. The audit covered configuration, paper/live wallet flow, 0x execution boundaries, persistent state, transaction recovery, accounting, Telegram reporting, price tracking, dependency declarations, and release artifacts.

## Result

The source tree is internally consistent and passes the strict TypeScript audit configuration used for this release. The runtime is designed for two supported deployments: Arc (`5042`) and Robinhood Chain (`4663`), with `CHAINS=ARC,Robinhood` as the default.

## Verified

- Package version is `2.0.0`.
- Default chain list is `ARC,Robinhood`.
- `MODE=paper` uses persisted virtual balances and does not create a signing wallet.
- `MODE=live` requires `MNEMONIC` and `LIVE_TRADING_CONFIRM=YES`.
- Live wallets are managed per chain and mnemonic material is never persisted to bot state.
- 0x quote flow is wallet-free; live execution is wallet-bound through `swidge()`.
- 0x ERC-20 approvals remain delegated to the WDK module; the application contains no Settler allowance logic.
- Submitted live swaps are persisted before confirmation polling and retained across timeout/restart until terminal status can be reconciled.
- Pending live swaps are excluded from scheduled wallet-balance overwrites until settlement, preventing temporary double-counting/under-counting.
- Native-base accounting (Arc) does not subtract the same successful gas cost twice. Failed native-base transaction gas is charged to realized PnL because there is no trade position in which to absorb it.
- Signed realized PnL is accepted and repaired during state migration.
- The previous invalid-`BigInt()` startup state failure is repaired by defensive state normalization.
- `MAX_OPEN_POSITIONS` also counts unresolved pending BUYs, preventing a burst of timed-out entries from exceeding the configured position capacity.
- Telegram startup, status, trade, pending, error, and shutdown messages include chain context.
- Telegram startup verifies both bot credentials and the configured destination chat.
- All runtime tuning values exposed by the configuration layer are represented in `.env.example`.
- `oxfile.toml` is deployment-specific configuration, not portable product source:
  it carries absolute paths (`/home/mdev/Programming/evm_based_trading`,
  `/usr/bin/bun`) valid only on the target host. `scripts/ox-health.sh` is a
  manual liveness probe; the oxmgr health executor stays unused (see oxfile
  comments). No root `state.json` exists; per-mode/per-chain state lives in
  `.data/` (gitignored).
- No internal ChatGPT citation markup or runtime secrets are present in the release files.

## Local validation

The release passed:

```text
Strict TypeScript compile: PASS
Configuration smoke test: PASS
JSON manifest validation: PASS
Environment-schema coverage: PASS (84 example variables)
Legacy/runtime artifact check: PASS
```

The audit environment did not have the Bun executable or installed project dependencies, so an actual `bun test` run and live blockchain transaction were not executed in this environment. The repository contains the `bun run check` command for the target Bun environment.

## Post-audit changes (2026-09-30, unreleased, deployed as ARC-only paper)

- TIME-stop exits through the real 0x sell-quote path (paper and live); no mark settlement.
- Paper fills at quote minimum with modeled approval+swap gas; Arc paper sell
  realized PnL is net of gas (matches live wallet-delta settlement, no double count).
- Hard stop-loss (`STOP_LOSS_PERCENT`), daily-loss halt (`MAX_DAILY_LOSS_PCT`),
  runner TP ladder, earlier trailing activation.
- Live journal: write-ahead PREPARED records, UNKNOWN retention on submission
  failure with one-time manual-review flagging; pending records preserve token
  name and entry liquidity.
- Deterministic price venue per token (signal pair → highest liquidity → first).
- Staggered DexPaprika enrichment (batches of 5 + 250 ms gap).
- Scope clarification: the excluded item is a market-data warehouse, not the
  trade/exit/skip analytics database.
- Status: engineering/measurement release. Trading edge remains unproven
  (outlier-dependent history, small post-change sample); see PERFORMANCE_REPORT.md.

## Operational caveats

`@tetherto/wdk-wallet-evm` is currently a beta dependency. The upstream WDK 0x module documents mainnet execution verification on Base, so the exact Arc and Robinhood deployment should be exercised with a dedicated wallet and very small live amounts before larger capital is introduced.

The bot intentionally does not include automatic candidate filtering, RPC failover, historical research storage, cross-chain bridging, or a web dashboard. These exclusions keep the 2.0.0 runtime small and deterministic.

## Reference documentation

- https://docs.0x.org/docs/introduction/supported-chains
- https://docs.0x.org/api-reference/api-overview
- https://github.com/0xProject/wdk-protocol-swidge-0x
- https://docs.dexscreener.com/api/reference
