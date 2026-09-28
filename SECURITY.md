# Security

This project can sign and submit real blockchain transactions in `MODE=live`. Treat the runtime as wallet software.

## Secrets

Keep `.env` private. Never commit `MNEMONIC`, `ZERO_EX_API_KEY`, `TELEGRAM_BOT_TOKEN`, or provider credentials. The mnemonic is passed directly to the WDK wallet layer and is not persisted by this application.

## 0x approvals

The application does not approve the 0x Settler contract. ERC-20 approval is delegated to the WDK 0x module. Do not add hard-coded Settler allowances.

## Live rollout

Use a dedicated wallet, a small initial position size, a trusted RPC provider, and verify the wallet address before enabling live trading. Keep the live state directory backed up.

## Recovery

Submitted live swaps are journaled before confirmation. Do not delete `.data/live/` while trades are pending or open. If an automatic reconciliation remains unresolved, stop the bot and inspect the transaction on-chain before manually changing state.
