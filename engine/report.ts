import { formatUnits, type ChainConfig, type TradingMode } from "../services/config";

/** Balance snapshot in raw base units. */
export type BalanceSnapshot = {
  baseRaw: bigint;
  nativeRaw: bigint;
};

/** Win-rate snapshot read from the state store. */
export type WinRateSnapshot = {
  wins: number;
  losses: number;
  entries: number;
  openPositions: number;
};

/** Format a USD price without scientific notation. */
export function formatUsd(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "N/A";
  if (price >= 1000) {
    return `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.01) return `$${price.toFixed(6)}`;
  if (price >= 0.000001) {
    return `$${price.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${price.toExponential(2)}`;
}

/** Format a signed percent value with two decimals. */
export function formatGainPct(gainPercent: number): string {
  if (!Number.isFinite(gainPercent)) return "N/A";
  const sign = gainPercent > 0 ? "+" : "";
  return `${sign}${gainPercent.toFixed(2)}%`;
}

/** Format compact USD liquidity, e.g. $1.23M. */
export function formatLiquidity(liquidityUsd: number | null): string {
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd)) return "N/A";
  if (liquidityUsd >= 1_000_000) return `$${(liquidityUsd / 1_000_000).toFixed(2)}M`;
  if (liquidityUsd >= 1_000) return `$${(liquidityUsd / 1_000).toFixed(2)}K`;
  return `$${liquidityUsd.toFixed(2)}`;
}

/** Format a millisecond duration as "2h 15m", "3m 20s" or "45s". */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "N/A";
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Compute win rate from raw win/loss counters. */
export function winRatePercent(wins: number, losses: number): number {
  const closed = wins + losses;
  return closed === 0 ? 0 : (wins / closed) * 100;
}

/** One-line win-rate summary for trade reports. */
export function formatWinRate(stats: WinRateSnapshot): string {
  const closed = stats.wins + stats.losses;
  return `${winRatePercent(stats.wins, stats.losses).toFixed(2)}% (${stats.wins}W/${stats.losses}L of ${closed} closed)`;
}

/** USD hint for a base-asset raw amount, e.g. " (~$10.00)". Empty without a rate. */
export function baseUsdHint(
  raw: bigint,
  chain: ChainConfig,
  rate: number | null | undefined,
): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return "";
  const absolute = raw < 0n ? -raw : raw;
  return usdHintForUnits(Number(absolute) / 10 ** chain.baseDecimals, rate);
}

/** USD hint for a native-gas raw amount via the accounting base rate. */
export function nativeUsdHint(
  raw: bigint,
  chain: ChainConfig,
  rate: number | null | undefined,
): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) return "";
  const absolute = raw < 0n ? -raw : raw;
  const units = Number(absolute) / 10 ** chain.nativeDecimals;
  return usdHintForUnits(units * chain.nativeToBaseRate, rate);
}

function usdHintForUnits(units: number, rate: number): string {
  // NOTE: never use "~" here — Telegram MarkdownV2 renders ~text~ as
  // strikethrough, so paired "(~$..)" hints put a line through everything
  // between them. "≈" carries the same meaning with no markup side effect.
  const usd = units * rate;
  if (!Number.isFinite(usd)) return "";
  if (usd >= 1000) return ` (≈$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })})`;
  if (usd >= 0.01) return ` (≈$${usd.toFixed(2)})`;
  if (usd > 0) return ` (≈$${usd.toPrecision(2)})`;
  return " (≈$0.00)";
}

/** Human label for a signal feed id. */
export function formatSource(source: string | null | undefined): string {
  switch (source) {
    case "dexpaprika-pools":
      return "DexPaprika pools";
    case "debot-community":
      return "Debot rank";
    case "debot-dashboard":
      return "Debot dashboard";
    case "unknown":
    case "":
    case null:
    case undefined:
      return "unknown";
    default:
      return source;
  }
}

/** Short chain label requested by traders: "Arc" or "Robinhood". */
export function chainLabel(chain: ChainConfig): string {
  return chain.key === "ARC" ? "Arc" : "Robinhood";
}

/** Full chain line with id, e.g. "Robinhood (4663)". */
export function chainLine(chain: ChainConfig): string {
  return `${chainLabel(chain)} (ID ${chain.chainId})`;
}

/** DexScreener chart URL for a pair when the LP address is known. */
export function chartUrl(chain: ChainConfig, pairAddress: string): string {
  return `https://dexscreener.com/${chain.dexScreenerChain}/${pairAddress}`;
}

function baseAmount(raw: bigint, chain: ChainConfig): string {
  return `${formatUnits(raw, chain.baseDecimals)} ${chain.baseSymbol}`;
}

function nativeAmount(raw: bigint, chain: ChainConfig): string {
  return `${formatUnits(raw, chain.nativeDecimals)} ${chain.nativeSymbol}`;
}

function identityLine(
  tokenName: string,
  symbol: string,
  dex: string,
  quoteSymbol: string,
  liquidityUsd: number | null,
  source?: string | null,
): string {
  const quote = quoteSymbol ? `/${quoteSymbol}` : "";
  const base = `🪙 ${tokenName} (${symbol}) · ${dex}${quote} · 💧 ${formatLiquidity(liquidityUsd)}`;
  return source === undefined ? base : `${base} · 📡 Source: ${formatSource(source)}`;
}

function addressLine(tokenAddress: string, pairAddress: string): string {
  return pairAddress
    ? `📝 CA: \`${tokenAddress}\` · 🏊 LP: \`${pairAddress}\``
    : `📝 CA: \`${tokenAddress}\` · 🏊 LP: N/A`;
}

function balanceLine(
  chain: ChainConfig,
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  baseUsdRate?: number | null,
): string {
  return (
    `💼 ${baseAmount(before.baseRaw, chain)} → ${baseAmount(after.baseRaw, chain)}${baseUsdHint(after.baseRaw, chain, baseUsdRate)}` +
    ` · ⛽ ${nativeAmount(before.nativeRaw, chain)} → ${nativeAmount(after.nativeRaw, chain)}${nativeUsdHint(after.nativeRaw, chain, baseUsdRate)}`
  );
}

function statsLine(stats: WinRateSnapshot): string {
  return `📊 Win rate: ${formatWinRate(stats)} · Entries: ${stats.entries} · Open: ${stats.openPositions}`;
}

export type BuyReportInput = {
  chain: ChainConfig;
  mode: TradingMode;
  tokenName: string;
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  dex: string;
  quoteSymbol: string;
  liquidityUsd: number | null;
  entryPriceUsd: number;
  quantityRaw: bigint;
  quantityDecimals: number;
  costBaseRaw: bigint;
  networkFeeRaw: bigint;
  before: BalanceSnapshot;
  after: BalanceSnapshot;
  stats: WinRateSnapshot;
  tpSummary: string;
  /** Base-asset USD rate for "(~$..)" hints; omit when unknown. */
  baseUsdRate?: number | null;
  /** Feed that produced the signal; shown for source comparison. */
  source?: string;
  txHash?: string;
  explorerUrl?: string;
};

/** Compact BUY report for opened paper and live positions. */
export function buildBuyMessage(input: BuyReportInput): string {
  const quote = input.quoteSymbol ? `/${input.quoteSymbol}` : "";
  const lines = [
    `🟢 **BUY — ${input.symbol}${quote}** · ${chainLine(input.chain)} · ${input.mode.toUpperCase()}`,
    identityLine(
      input.tokenName,
      input.symbol,
      input.dex,
      input.quoteSymbol,
      input.liquidityUsd,
      input.source,
    ),
    addressLine(input.tokenAddress, input.pairAddress),
    `💰 Entry ${formatUsd(input.entryPriceUsd)} · Qty ${formatUnits(input.quantityRaw, input.quantityDecimals)} ${input.symbol} · Cost ${baseAmount(input.costBaseRaw, input.chain)}${baseUsdHint(input.costBaseRaw, input.chain, input.baseUsdRate)} · Gas ${nativeAmount(input.networkFeeRaw, input.chain)}`,
    `🎯 TP ${input.tpSummary} · ${statsLine(input.stats)}`,
    balanceLine(input.chain, input.before, input.after, input.baseUsdRate),
  ];
  if (input.pairAddress) lines.push(`🔗 Chart: ${chartUrl(input.chain, input.pairAddress)}`);
  if (input.txHash) {
    lines.push(`🧾 Tx: \`${input.txHash}\``);
    if (input.explorerUrl) lines.push(`🔍 Explorer: ${input.explorerUrl}${input.txHash}`);
  }
  return lines.join("\n");
}

export type ExitReportInput = {
  chain: ChainConfig;
  mode: TradingMode;
  closed: boolean;
  reason: string;
  tokenName: string;
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  dex: string;
  quoteSymbol: string;
  liquidityUsd: number | null;
  entryPriceUsd: number;
  exitPriceUsd: number;
  highestPriceUsd: number;
  sellPercent: number;
  proceedsBaseRaw: bigint;
  realizedPnlBaseRaw: bigint;
  totalPositionPnlBaseRaw: bigint;
  remainingQuantityRaw: bigint;
  remainingQuantityDecimals: number;
  remainingCostBaseRaw: bigint;
  networkFeeRaw: bigint;
  before: BalanceSnapshot;
  after: BalanceSnapshot;
  openedAt: number;
  closedAt: number;
  stats: WinRateSnapshot;
  /** Base-asset USD rate for "(~$..)" hints; omit when unknown. */
  baseUsdRate?: number | null;
  /** Feed that opened the position; shown for source comparison. */
  source?: string;
  txHash?: string;
  explorerUrl?: string;
};

/** Compact PARTIAL TP / CLOSE / TRAIL report for paper and live exits. */
export function buildExitMessage(input: ExitReportInput): string {
  const gainPct = input.entryPriceUsd > 0
    ? ((input.exitPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100
    : Number.NaN;
  const pnlNegative = input.realizedPnlBaseRaw < 0n;
  const closedNegative = input.totalPositionPnlBaseRaw < 0n;
  const title = input.closed
    ? input.reason === "TRAIL"
      ? `🛡️ **TRAIL CLOSE — ${input.symbol}**`
      : input.reason === "STOP"
        ? `🛑 **STOP CLOSE — ${input.symbol}**`
        : `🔵 **CLOSE — ${input.symbol}**`
    : `🟡 **PARTIAL TP — ${input.symbol}**`;
  const outcome = input.closed ? (closedNegative ? "❌ LOSS" : "✅ WIN") : pnlNegative ? "➖" : "➕";

  const lines = [
    `${title} · ${chainLine(input.chain)} · ${input.mode.toUpperCase()} ${outcome}`,
    `📋 Reason: ${input.reason}${input.closed ? "" : ` · Sold ${input.sellPercent}%`} · 📡 Source: ${formatSource(input.source)}`,
    identityLine(
      input.tokenName,
      input.symbol,
      input.dex,
      input.quoteSymbol,
      input.liquidityUsd,
    ),
    addressLine(input.tokenAddress, input.pairAddress),
    `💰 Entry: ${formatUsd(input.entryPriceUsd)} → Exit: ${formatUsd(input.exitPriceUsd)} (${formatGainPct(gainPct)}) · High: ${formatUsd(input.highestPriceUsd)}`,
    `💵 Proceeds: ${baseAmount(input.proceedsBaseRaw, input.chain)}${baseUsdHint(input.proceedsBaseRaw, input.chain, input.baseUsdRate)} · 💸 PnL: ${input.realizedPnlBaseRaw < 0n ? "−" : "+"}${baseAmount(input.realizedPnlBaseRaw < 0n ? -input.realizedPnlBaseRaw : input.realizedPnlBaseRaw, input.chain)} · 🧮 Total: ${input.totalPositionPnlBaseRaw < 0n ? "−" : "+"}${baseAmount(input.totalPositionPnlBaseRaw < 0n ? -input.totalPositionPnlBaseRaw : input.totalPositionPnlBaseRaw, input.chain)} · ⛽ Gas: ${nativeAmount(input.networkFeeRaw, input.chain)}`,
  ];

  if (!input.closed) {
    lines.push(
      `📦 Remaining: ${formatUnits(input.remainingQuantityRaw, input.remainingQuantityDecimals)} ${input.symbol} · Cost left: ${baseAmount(input.remainingCostBaseRaw, input.chain)}`,
    );
  }

  lines.push(
    balanceLine(input.chain, input.before, input.after, input.baseUsdRate),
    `⏱️ Duration: ${formatDuration(input.closedAt - input.openedAt)} · ${statsLine(input.stats)}`,
  );
  if (input.pairAddress) lines.push(`🔗 Chart: ${chartUrl(input.chain, input.pairAddress)}`);
  if (input.txHash) {
    lines.push(`🧾 Tx: \`${input.txHash}\``);
    if (input.explorerUrl) lines.push(`🔍 Explorer: ${input.explorerUrl}${input.txHash}`);
  }
  return lines.join("\n");
}

export type TrailingReportInput = {
  chain: ChainConfig;
  mode: TradingMode;
  tokenName: string;
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  dex: string;
  quoteSymbol: string;
  liquidityUsd: number | null;
  entryPriceUsd: number;
  currentPriceUsd: number;
  highestPriceUsd: number;
  activationPercent: number;
  distancePercent: number;
  openedAt: number;
  stats: WinRateSnapshot;
};

/** Compact TRAILING ACTIVATED report. */
export function buildTrailingMessage(input: TrailingReportInput): string {
  const gainPct = input.entryPriceUsd > 0
    ? ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100
    : Number.NaN;
  const stopPrice = input.highestPriceUsd * (1 - input.distancePercent / 100);
  return [
    `🛡️ **TRAILING ON — ${input.symbol}** · ${chainLine(input.chain)} · ${input.mode.toUpperCase()}`,
    identityLine(
      input.tokenName,
      input.symbol,
      input.dex,
      input.quoteSymbol,
      input.liquidityUsd,
    ),
    addressLine(input.tokenAddress, input.pairAddress),
    `💰 Entry: ${formatUsd(input.entryPriceUsd)} | Now: ${formatUsd(input.currentPriceUsd)} (${formatGainPct(gainPct)}) · High: ${formatUsd(input.highestPriceUsd)} · Stop: ${formatUsd(stopPrice)} (−${input.distancePercent}% from high)`,
    `🎯 Activation: +${input.activationPercent}% · ⏱️ Open for: ${formatDuration(Date.now() - input.openedAt)} · ${statsLine(input.stats)}`,
  ].join("\n");
}

export type PlumbingReportInput = {
  chain: ChainConfig;
  mode: TradingMode;
  kind: "BUY_SUBMITTED" | "SELL_SUBMITTED" | "BUY_PENDING" | "SELL_PENDING" | "FAILED";
  symbol: string;
  tokenAddress: string;
  pairAddress: string;
  dex: string;
  reason: string;
  amountLabel: string;
  txHash: string;
  explorerUrl: string;
  note?: string;
};

/** Compact live-plumbing report (submitted / pending / failed settlement). */
export function buildPlumbingMessage(input: PlumbingReportInput): string {
  const icon = input.kind === "FAILED"
    ? "🔴"
    : input.kind === "BUY_PENDING" || input.kind === "SELL_PENDING"
      ? "🟠"
      : "🟡";
  const title = input.kind === "FAILED"
    ? `${icon} **${input.reason} FAILED — ${input.symbol}**`
    : input.kind.endsWith("SUBMITTED")
      ? `${icon} **${input.reason} SUBMITTED — ${input.symbol}**`
      : `${icon} **${input.reason} PENDING — ${input.symbol}**`;
  const lines = [
    `${title} · ${chainLine(input.chain)} · ${input.mode.toUpperCase()}`,
    `🪙 ${input.symbol} · ${input.dex} · 📝 CA: \`${input.tokenAddress}\`${input.pairAddress ? ` · 🏊 LP: \`${input.pairAddress}\`` : ""}`,
    `💵 Amount: ${input.amountLabel}`,
    `🧾 Tx: \`${input.txHash}\``,
    `🔍 Explorer: ${input.explorerUrl}${input.txHash}`,
  ];
  if (input.pairAddress) lines.push(`🔗 Chart: ${chartUrl(input.chain, input.pairAddress)}`);
  if (input.note) lines.push(`ℹ️ ${input.note}`);
  return lines.join("\n");
}
