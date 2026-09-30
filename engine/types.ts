import type { TradingMode } from "../services/config";

/** Entry-time market snapshot for one signal/position.
 *
 * Captured once at signal time (never refreshed) so later analysis can
 * correlate outcomes with the exact liquidity/volume/mcap the bot saw when
 * it decided. Every field is null when the producing feed did not report it
 * (e.g. Debot dashboard items carry price only until enriched).
 */
export type EntrySnapshot = {
  /** 24h trading volume in USD (Debot market_info.volume / DexPaprika 24h). */
  volumeUsd24h: number | null;
  /** 24h transaction count (Debot swaps / DexPaprika transactions_24h). */
  txns24h: number | null;
  /** 24h buy count when reported. */
  buys24h: number | null;
  /** 24h sell count when reported. */
  sells24h: number | null;
  /** Circulating market cap in USD (Debot mkt_cap / DexPaprika market_cap). */
  mktCapUsd: number | null;
  /** Fully diluted valuation in USD. */
  fdvUsd: number | null;
  /** Holder count (Debot market_info.holders). */
  holders: number | null;
  /** Pool/token creation time as ms epoch (Debot creation_timestamp / DexPaprika created_at). */
  poolCreatedAtMs: number | null;
};

/** Blank snapshot for feeds that report price only. */
export function emptySnapshot(): EntrySnapshot {
  return {
    volumeUsd24h: null,
    txns24h: null,
    buys24h: null,
    sells24h: null,
    mktCapUsd: null,
    fdvUsd: null,
    holders: null,
    poolCreatedAtMs: null,
  };
}

/** Keep finite positive numbers, coerce anything else to null. */
export function snapshotNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalize a creation timestamp in either seconds or ms to ms epoch. */
export function snapshotTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value : value * 1000;
}

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
  /** Entry-time market context; empty when the feed reports price only. */
  snapshot: EntrySnapshot;
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
  /** Entry-time market context, frozen at open for later filter analysis. */
  snapshot: EntrySnapshot;
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
  /** Full token name; falls back to the symbol for legacy journal entries. */
  tokenName: string;
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
  /** Entry-time market context, settled onto the position at fill. */
  snapshot: EntrySnapshot;
  /** Feed that opened the position; "unknown" for legacy journal entries. */
  source: string;
  /** Entry-time liquidity; null when the feed did not report it. */
  entryLiquidityUsd: number | null;
  /**
   * Journal stage for crash-window recovery. PREPARED is written before the
   * wallet submission returns; SUBMITTED carries a real on-chain id; UNKNOWN
   * means the submission threw and the tx may or may not have broadcast.
   */
  stage: "PREPARED" | "SUBMITTED" | "UNKNOWN";
  /** Whether an UNKNOWN/PREPARED record was already flagged for manual review. */
  reviewNotified: boolean;
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
  /** UTC day (YYYY-MM-DD) the daily-loss halt baseline was taken. */
  riskDay: string;
  /** Realized PnL at the start of riskDay; day loss = current − baseline. */
  riskDayStartRealizedPnlRaw: string;
};
