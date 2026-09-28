import type { TradingMode } from "../services/config";

/** Debot candidate normalized into the engine's chain-independent signal shape. */
export type Signal = {
  tokenAddress: string;
  symbol: string;
  /** Full token name from Debot; falls back to the symbol. */
  name: string;
  decimals: number;
  pairAddress: string;
  priceUsd: number;
  /** Venue reported by Debot (dex_name); "unknown" when absent. */
  dex: string;
  /** Quote-side symbol (e.g. WETH/USDC); may be empty until DexScreener refreshes it. */
  quoteSymbol: string;
  /** Pair liquidity in USD when reported. */
  liquidityUsd: number | null;
  /** Feed that produced the signal: debot-community, debot-dashboard, dexpaprika-pools. */
  source: string;
};

/** DexScreener price snapshot normalized for the engine. */
export type PriceUpdate = {
  tokenAddress: string;
  symbol: string;
  pairAddress: string;
  dexId: string;
  quoteSymbol: string;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
};

/** Persisted state for one open trading position. */
export type Position = {
  tokenAddress: string;
  symbol: string;
  /** Full token name; falls back to the symbol for legacy state. */
  name: string;
  decimals: number;
  quantityRaw: string;
  initialQuantityRaw: string;
  costBaseRaw: string;
  /** Cumulative realized PnL, including gas expenses from failed live transactions. */
  realizedPnlBaseRaw: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  highestPriceUsd: number;
  /** Cumulative native gas attributed to this position. */
  feesNativeRaw: string;
  takeProfitIndex: number;
  trailingActivated: boolean;
  openedAt: number;
  lastActionAt: number;
  /** Pair/LP address; refreshed from DexScreener on every price update. */
  pairAddress: string;
  /** Trading venue (Debot dex_name or DexScreener dexId). */
  dex: string;
  /** Quote-side symbol (e.g. WETH/USDC). */
  quoteSymbol: string;
  /** Latest known pair liquidity in USD. */
  liquidityUsd: number | null;
  /** Feed that opened the position; "unknown" for legacy state. */
  source: string;
};

/** Persisted live swap journal entry used for timeout/restart recovery. */
export type PendingSwap = {
  id: string;
  hash: string;
  side: "BUY" | "SELL";
  tokenAddress: string;
  symbol: string;
  decimals: number;
  reason: string;
  requestedAmountRaw: string;
  signalPriceUsd: number;
  beforeBaseRaw: string;
  beforeNativeRaw: string;
  beforeTokenRaw: string;
  estimatedNetworkFeeRaw: string;
  submittedAt: number;
  /** Pair/LP address for reporting; may be empty for legacy journal entries. */
  pairAddress: string;
  /** Trading venue for reporting. */
  dex: string;
  /** Feed that opened the position; "unknown" for legacy journal entries. */
  source: string;
};

export type WalletState = {
  version: 3;
  mode: TradingMode;
  chain: string;
  balanceBaseRaw: string;
  balanceNativeRaw: string;
  initialBalanceBaseRaw: string;
  initialBalanceNativeRaw: string;
  realizedPnlBaseRaw: string;
  networkFeesNativeRaw: string;
  entries: number;
  wins: number;
  losses: number;
  positions: Record<string, Position>;
  pendingSwaps: Record<string, PendingSwap>;
  peakEquityBase: number;
  maxDrawdownBase: number;
  lastWalletSyncAt: number;
};
