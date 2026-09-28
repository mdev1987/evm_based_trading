# Changelog

## 2.0.0 — 2026-09-29

- Finalized paper/live wallet execution for Arc and Robinhood Chain.
- Moved runtime tuning and chain overrides into `.env`.
- Default chains are `ARC,Robinhood`.
- Added persistent live pending-swap journal and restart/timeout reconciliation.
- Fixed signed realized-PnL persistence/reporting.
- Fixed native-base gas from being double-counted in net PnL.
- Added chain-aware Telegram startup, status, trade, error and recovery messages.
- Added Telegram destination verification.
- Added defensive state migration/repair and per-mode/per-chain state isolation.
- Removed stale legacy configuration/scripts and simplified TypeScript configuration.
- Added a single `bun run check` command for typecheck + tests.
- Counted unresolved pending BUYs toward the configured open-position limit.
- Added explorer links to live transaction Telegram reports.

## 1.0.0

Initial paper/live EVM trading bot release.
