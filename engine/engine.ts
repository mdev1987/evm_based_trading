import type { ChainConfig, TradingMode } from "../services/config";
import { formatUnits } from "../services/config";
import { getZeroExQuote, ZeroExQuoteError, type ZeroExQuote, type ZeroExQuoteParams } from "../services/zero_ex";
import type { EvmWalletService } from "../services/wallet";
import type { HistoryService } from "../services/history";
import type { StateStore } from "./store";
import { Strategy } from "./strategy";
import type { PendingSwap, PriceUpdate, Position, Signal } from "./types";
import { emptySnapshot } from "./types";
import {
  buildBuyMessage,
  buildExitMessage,
  buildPlumbingMessage,
  buildTrailingMessage,
  type BalanceSnapshot,
  type WinRateSnapshot,
} from "./report";

export type TradingEngineConfig = {
  chain: ChainConfig;
  mode: TradingMode;
  buyAmountBaseRaw: bigint;
  maxOpenPositions: number;
  /** Block new entries after losing this % of initial bank in one UTC day; 0 disables. */
  maxDailyLossPct: number;
  /** Base-asset USD rate for display hints; null when unknown. */
  baseUsdRate: number | null;
  /**
   * Quote function for 0x indicative prices. Defaults to the live quote path;
   * tests inject a stub so exits can be exercised without network access.
   * Paper and live use the same function, so paper fills/fees match the
   * live preflight exactly.
   */
  quoteFn?: (params: ZeroExQuoteParams) => Promise<ZeroExQuote>;
  /** DuckDB analytical mirror; null disables history writes (fail-open). */
  history?: HistoryService | null;
};

/** Compact USD for entry logs, e.g. $1.23M / $4.56K / n/a. */
function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export type EngineStats = {
  chain: string;
  mode: TradingMode;
  baseSymbol: string;
  nativeSymbol: string;
  balanceBase: number;
  balanceNative: number;
  openPositions: number;
  entries: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnlBase: number;
  unrealizedPnlBase: number;
  networkFeesNative: number;
  netPnlBase: number;
  equityBase: number;
  peakEquityBase: number;
  maxDrawdownBase: number;
  pendingSwaps: number;
};

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`Invalid integer value for ${field}`);
}

function toSignedBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Invalid signed integer value for ${field}`);
}

function getNetworkFee(quote: Awaited<ReturnType<typeof getZeroExQuote>>): bigint {
  for (const fee of quote.fees) {
    if (fee.type === "network") return toBigInt(fee.amount, "0x network fee");
  }
  return 0n;
}

function positiveDelta(after: bigint, before: bigint): bigint {
  return after > before ? after - before : 0n;
}

function positiveLoss(before: bigint, after: bigint): bigint {
  return before > after ? before - after : 0n;
}

/**
 * Core trading engine for one chain.
 *
 * It owns strategy decisions and accounting. Debot, DexScreener, Telegram,
 * WDK, and 0x are deliberately kept behind service boundaries.
 */
export class TradingEngine {
  private queue = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly strategy: Strategy,
    private readonly config: TradingEngineConfig,
    private readonly wallet?: EvmWalletService,
    private readonly notifyCallback?: (message: string) => Promise<void>,
  ) {}

  /** Serialize all position and wallet mutations to prevent race conditions. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Report an event without allowing Telegram failures to break trading. */
  private async notify(message: string): Promise<void> {
    if (!this.notifyCallback) return;

    try {
      await this.notifyCallback(message);
    } catch (error) {
      console.error(
        `[ENGINE][${this.config.chain.name}] notification failed: ${String(error)}`,
      );
    }
  }

  /** Snapshot win-rate counters for trade reports. */
  private winRateSnapshot(): WinRateSnapshot {
    const state = this.store.data;
    return {
      wins: state.wins,
      losses: state.losses,
      entries: state.entries,
      openPositions: Object.keys(state.positions).length,
    };
  }

  /** Display metadata for a position with legacy-state fallbacks. */
  private positionMeta(position: Position): {
    tokenName: string;
    quoteSymbol: string;
    dex: string;
  } {
    return {
      tokenName: position.name || position.symbol,
      quoteSymbol: position.quoteSymbol || this.config.chain.baseSymbol,
      dex: position.dex || "unknown",
    };
  }

  /** Return tokens currently held and therefore requiring price tracking. */
  getPositionTokens(): string[] {
    return Object.values(this.store.data.positions).map(
      (position) => position.tokenAddress,
    );
  }

  /** Return open-position and pending-swap tokens that should remain price-tracked. */
  getTrackingTokens(): string[] {
    const tokens = new Set(this.getPositionTokens());
    for (const pending of Object.values(this.store.data.pendingSwaps)) {
      tokens.add(pending.tokenAddress);
    }
    return [...tokens];
  }

  /**
   * Signal-pair pinning for deterministic price selection (token → pair).
   * Each token is permanently pinned to the pair that generated its signal
   * whenever that pair still reports a price; signalPairAddress is immutable,
   * so a fallback venue can never hijack the preference (pairAddress itself
   * keeps tracking the currently selected display venue).
   */
  getPricePreferences(): Map<string, string> {
    const map = new Map<string, string>();
    for (const position of Object.values(this.store.data.positions)) {
      const pinned = position.signalPairAddress || position.pairAddress;
      if (pinned) {
        map.set(position.tokenAddress.toLowerCase(), pinned);
      }
    }
    for (const pending of Object.values(this.store.data.pendingSwaps)) {
      const key = pending.tokenAddress.toLowerCase();
      if (pending.pairAddress && !map.has(key)) map.set(key, pending.pairAddress);
    }
    return map;
  }

  /** Return whether a live transaction is already pending for a token. */
  /** DuckDB analytical mirror; null when history is disabled (fail-open). */
  private history(): HistoryService | null {
    return this.config.history ?? null;
  }

  /** Mirror one opened position into the history database (never throws). */
  private recordEntry(position: Position, costRaw: bigint): Promise<void> {
    return this.history()?.recordEntry({
      chain: this.config.chain.name,
      mode: this.config.mode,
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      name: position.name,
      source: position.source,
      dex: position.dex,
      pairAddress: position.pairAddress,
      openedAt: position.openedAt,
      entryPriceUsd: position.entryPriceUsd,
      entryCostRaw: costRaw.toString(),
      entryCostDisplay: Number(formatUnits(costRaw, this.config.chain.baseDecimals)),
      baseSymbol: this.config.chain.baseSymbol,
      baseDecimals: this.config.chain.baseDecimals,
      liqUsd: position.liquidityUsd,
      vol24Usd: position.snapshot.volumeUsd24h,
      txns24: position.snapshot.txns24h,
      buys24: position.snapshot.buys24h,
      sells24: position.snapshot.sells24h,
      mcapUsd: position.snapshot.mktCapUsd,
      fdvUsd: position.snapshot.fdvUsd,
      holders: position.snapshot.holders,
    }) ?? Promise.resolve();
  }

  private hasPendingForToken(tokenAddress: string): boolean {    const key = tokenAddress.toLowerCase();
    return Object.values(this.store.data.pendingSwaps).some(
      (pending) => pending.tokenAddress.toLowerCase() === key,
    );
  }

  /**
   * Daily loss halt: refuse new entries once today's realized loss reaches
   * maxDailyLossPct of the initial bank. The baseline resets on UTC day
   * rollover and persists in state across restarts. Open positions keep
   * managing out through TP/trail/stop/time — exits are never blocked.
   */
  private async checkDailyLossHalt(): Promise<string | null> {
    const pct = this.config.maxDailyLossPct;
    if (!(pct > 0)) return null;

    const day = new Date().toISOString().slice(0, 10);
    const state = this.store.data;
    let baseline: bigint;
    if (state.riskDay !== day) {
      baseline = toSignedBigInt(state.realizedPnlBaseRaw, "realizedPnlBaseRaw");
      const baselineRaw = baseline.toString();
      await this.store.update((draft) => {
        draft.riskDay = day;
        draft.riskDayStartRealizedPnlRaw = baselineRaw;
      });
    } else {
      baseline = toSignedBigInt(
        state.riskDayStartRealizedPnlRaw,
        "riskDayStartRealizedPnlRaw",
      );
    }

    const current = toSignedBigInt(
      this.store.data.realizedPnlBaseRaw,
      "realizedPnlBaseRaw",
    );
    const dayLoss = baseline - current;
    if (dayLoss <= 0n) return null;
    const initial = toBigInt(
      this.store.data.initialBalanceBaseRaw,
      "initialBalanceBaseRaw",
    );
    const maxLoss = (initial * BigInt(Math.round(pct * 100))) / 10000n;
    if (maxLoss > 0n && dayLoss >= maxLoss) {
      return `daily loss halt (−${pct}% of bank)`;
    }
    return null;
  }

  /**
   * Entry snapshot gate: enforce per-chain minimum liquidity, 24h volume and
   * 24h transaction count. A threshold of 0 disables that check. Missing data
   * fails a check that is enabled ("unverified") unless the chain allows
   * unverified snapshots — measured values are always gated either way.
   * Returns the skip reason, or null to pass.
   */
  private snapshotGate(signal: Signal): string | null {
    const { minLiquidityUsd, minVolumeUsd24h, minTxns24h, allowUnverifiedSnapshot } =
      this.config.chain;

    if (minLiquidityUsd > 0) {
      if (signal.liquidityUsd === null) {
        if (!allowUnverifiedSnapshot) {
          return `unverified liq (need >= ${compactUsd(minLiquidityUsd)})`;
        }
      } else if (signal.liquidityUsd < minLiquidityUsd) {
        return `low liq ${compactUsd(signal.liquidityUsd)} < ${compactUsd(minLiquidityUsd)}`;
      }
    }

    if (minVolumeUsd24h > 0) {
      if (signal.snapshot.volumeUsd24h === null) {
        if (!allowUnverifiedSnapshot) {
          return `unverified vol24 (need >= ${compactUsd(minVolumeUsd24h)})`;
        }
      } else if (signal.snapshot.volumeUsd24h < minVolumeUsd24h) {
        return `low vol24 ${compactUsd(signal.snapshot.volumeUsd24h)} < ${compactUsd(minVolumeUsd24h)}`;
      }
    }

    if (minTxns24h > 0) {
      if (signal.snapshot.txns24h === null) {
        if (!allowUnverifiedSnapshot) {
          return `unverified txns (need >= ${minTxns24h})`;
        }
      } else if (signal.snapshot.txns24h < minTxns24h) {
        return `low txns ${signal.snapshot.txns24h} < ${minTxns24h}`;
      }
    }

    return null;
  }

  /**
   * Reconcile live swaps that were submitted but not finalized by the previous
   * application run or by an execution timeout.
   *
   * Pending records are deliberately kept until a terminal on-chain state is
   * observed and the corresponding wallet balances can be reconciled.
   */
  async reconcilePendingSwaps(): Promise<void> {
    return this.enqueue(async () => {
      if (this.config.mode !== "live" || !this.wallet) return;

      const pending = Object.values(this.store.data.pendingSwaps);
      for (const swap of pending) {
        // PREPARED/UNKNOWN records carry no on-chain id (the submission result
        // never arrived), so there is nothing pollable — flag once for manual
        // review and keep the record blocking re-entry on that token.
        if (swap.stage !== "SUBMITTED") {
          await this.flagUnresolvedSubmission(swap);
          continue;
        }
        try {
          const status = await this.wallet.getSwapStatus(this.config.chain, swap.id);
          if (status.status === "pending") continue;

          await this.settlePendingSwap(swap, status.status);
        } catch (error) {
          console.error(
            `[ENGINE][${this.config.chain.name}] pending ${swap.symbol} ${swap.id} reconciliation deferred: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
  }

  /** Flag a journal record that can never resolve on-chain, exactly once. */
  private async flagUnresolvedSubmission(swap: PendingSwap): Promise<void> {
    if (swap.reviewNotified) return;
    console.error(
      `[ENGINE][${this.config.chain.name}] ${swap.symbol} ${swap.side} submission ${swap.stage}: no on-chain id — manual explorer review required`,
    );
    await this.notify(
      buildPlumbingMessage({
        chain: this.config.chain,
        mode: "live",
        kind: "FAILED",
        symbol: swap.symbol,
        tokenAddress: swap.tokenAddress,
        pairAddress: swap.pairAddress,
        dex: swap.dex || "unknown",
        reason: `${swap.side} SUBMISSION ${swap.stage}`,
        amountLabel: `Journal ${swap.id} | submitted ${new Date(swap.submittedAt).toISOString()}`,
        txHash: swap.hash || swap.id,
        explorerUrl: this.config.chain.explorerUrl,
        note: "No terminal status can be polled. Verify on the explorer and resolve manually; re-entry stays blocked.",
      }),
    );
    await this.store.update((state) => {
      const record = state.pendingSwaps[swap.id];
      if (record) record.reviewNotified = true;
    });
  }

  /** Persist current real wallet balances for live-mode recovery. */
  async syncLiveWallet(): Promise<void> {
    return this.enqueue(async () => {
      if (this.config.mode !== "live") return;
      if (!this.wallet) throw new Error("Live engine requires a wallet service");

      // Do not overwrite accounting balances while a submitted swap is still
      // unresolved. The on-chain wallet may already reflect the transaction
      // while the position ledger deliberately waits for terminal status.
      if (Object.keys(this.store.data.pendingSwaps).length > 0) return;

      const balances = await this.wallet.getBalances(this.config.chain);
      await this.store.update((state) => {
        state.balanceBaseRaw = balances.baseRaw.toString();
        state.balanceNativeRaw = balances.nativeRaw.toString();
        state.lastWalletSyncAt = Date.now();
      });
    });
  }

  /**
   * Accept a Debot signal and attempt one entry.
   *
   * Returns `true` only when a position was actually opened. Returning a
   * boolean lets the coordinator implement a clean re-entry cooldown without
   * guessing whether the engine accepted the signal.
   */
  async onSignal(signal: Signal): Promise<boolean> {
    return this.enqueue(async () => {
      const key = signal.tokenAddress.toLowerCase();

      if (this.store.data.positions[key]) return false;
      if (this.hasPendingForToken(key)) {
        console.log(
          `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: live swap already pending`,
        );
        return false;
      }

      const openPositions = Object.keys(this.store.data.positions).length;
      const pendingBuys = Object.values(this.store.data.pendingSwaps).filter(
        (pending) => pending.side === "BUY",
      ).length;
      if (openPositions + pendingBuys >= this.config.maxOpenPositions) {
        console.log(
          `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: max open/pending positions`,
        );
        return false;
      }

      // Cheap preflight before spending a 0x quote: the base leg must cover
      // the trade amount on its own (the fee leg is verified after the quote).
      // Paper reads the store for free; live keeps the post-quote check to
      // avoid an RPC storm per signal.
      if (this.config.mode === "paper") {
        const paperBase = toBigInt(
          this.store.data.balanceBaseRaw,
          "balanceBaseRaw",
        );
        if (paperBase < this.config.buyAmountBaseRaw) {
          console.log(
            `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: insufficient ${this.config.chain.baseSymbol} (pre-quote)`,
          );
          return false;
        }
      }

      const haltReason = await this.checkDailyLossHalt();
      if (haltReason) {
        console.log(
          `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: ${haltReason}`,
        );
        await this.history()?.recordSkip({
          chain: this.config.chain.name,
          symbol: signal.symbol,
          tokenAddress: signal.tokenAddress,
          source: signal.source,
          reason: "daily-loss-halt",
          liqUsd: signal.liquidityUsd,
          vol24Usd: signal.snapshot.volumeUsd24h,
          txns24: signal.snapshot.txns24h,
          eventAt: Date.now(),
        });
        return false;
      }

      const snapshotSkip = this.snapshotGate(signal);
      if (snapshotSkip) {
        console.log(
          `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: ${snapshotSkip}`,
        );
        await this.history()?.recordSkip({
          chain: this.config.chain.name,
          symbol: signal.symbol,
          tokenAddress: signal.tokenAddress,
          source: signal.source,
          reason: snapshotSkip,
          liqUsd: signal.liquidityUsd,
          vol24Usd: signal.snapshot.volumeUsd24h,
          txns24: signal.snapshot.txns24h,
          eventAt: Date.now(),
        });
        return false;
      }

      const action = this.strategy.evaluateSignal();
      if (action.type !== "BUY") return false;

      console.log(
        `[ENGINE][${this.config.chain.name}] BUY ${signal.symbol} ${signal.tokenAddress} ` +
          `(via ${signal.source}) | liq ${compactUsd(signal.liquidityUsd)} | ` +
          `vol24 ${compactUsd(signal.snapshot.volumeUsd24h)} | ` +
          `txns ${signal.snapshot.txns24h ?? "n/a"} | ` +
          `mcap ${compactUsd(signal.snapshot.mktCapUsd)}`,
      );

      let quote: Awaited<ReturnType<typeof getZeroExQuote>>;
      try {
        quote = await this.quote({
          chainId: this.config.chain.chainId,
          fromToken: this.config.chain.baseToken,
          toToken: signal.tokenAddress,
          fromTokenAmount: this.config.buyAmountBaseRaw,
        });
      } catch (error) {
        this.handleQuoteError("BUY", signal.symbol, error);
        if (error instanceof ZeroExQuoteError) {
          await this.history()?.recordSkip({
            chain: this.config.chain.name,
            symbol: signal.symbol,
            tokenAddress: signal.tokenAddress,
            source: signal.source,
            reason: `quote:${error.code}`,
            liqUsd: signal.liquidityUsd,
            vol24Usd: signal.snapshot.volumeUsd24h,
            txns24: signal.snapshot.txns24h,
            eventAt: Date.now(),
          });
        }
        return false;
      }

      const estimatedNetworkFee = getNetworkFee(quote);
      const before = await this.getWalletBalances();

      if (this.config.chain.baseIsNative) {
        // Native-base buys need no ERC-20 approval, in paper or live.
        if (before.baseRaw < this.config.buyAmountBaseRaw + estimatedNetworkFee) {
          console.log(
            `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: insufficient ${this.config.chain.baseSymbol} for trade + gas`,
          );
          return false;
        }
      } else {
        if (before.baseRaw < this.config.buyAmountBaseRaw) {
          console.log(
            `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: insufficient ${this.config.chain.baseSymbol}`,
          );
          return false;
        }
        // Live pays a separate approval tx when selling an ERC-20 base; paper
        // models it (see openPaperPosition), so preflight both at 2x fee.
        // Live preflight stays at 1x — settlement measures actual gas.
        const requiredNativeFee = this.config.mode === "paper"
          ? estimatedNetworkFee * 2n
          : estimatedNetworkFee;
        if (before.nativeRaw < requiredNativeFee) {
          console.log(
            `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: insufficient ${this.config.chain.nativeSymbol} for gas`,
          );
          return false;
        }
      }

      if (this.config.mode === "paper") {
        return this.openPaperPosition(signal, key, quote, estimatedNetworkFee, before);
      }

      return this.openLivePosition(signal, key, before, estimatedNetworkFee);
    });
  }

  /**
   * Apply a market-price update and invoke the strategy's exit rules.
   */
  async onPrice(price: PriceUpdate): Promise<void> {
    return this.enqueue(async () => {
      if (price.priceUsd === null || price.priceUsd <= 0) return;

      const key = price.tokenAddress.toLowerCase();
      const position = this.store.data.positions[key];
      if (!position) return;

      position.currentPriceUsd = price.priceUsd;
      const previousHigh = position.highestPriceUsd;

      // Keep venue metadata fresh: DexScreener knows the dominant pair/DEX.
      if (price.pairAddress) position.pairAddress = price.pairAddress;
      if (price.dexId) position.dex = price.dexId;
      if (price.quoteSymbol) position.quoteSymbol = price.quoteSymbol;
      if (price.liquidityUsd !== null) position.liquidityUsd = price.liquidityUsd;

      if (price.priceUsd > position.highestPriceUsd) {
        position.highestPriceUsd = price.priceUsd;
      }

      if (
        !position.trailingActivated &&
        this.strategy.shouldActivateTrailing(position)
      ) {
        position.trailingActivated = true;
        position.lastActionAt = Date.now();
        await this.store.save();

        console.log(
          `[ENGINE][${this.config.chain.name}] TRAILING ON ${position.symbol}`,
        );
        const trailing = this.strategy.getTrailing();
        const meta = this.positionMeta(position);
        await this.notify(
          buildTrailingMessage({
            chain: this.config.chain,
            mode: this.config.mode,
            tokenName: meta.tokenName,
            symbol: position.symbol,
            tokenAddress: position.tokenAddress,
            pairAddress: position.pairAddress,
            dex: meta.dex,
            quoteSymbol: meta.quoteSymbol,
            liquidityUsd: position.liquidityUsd,
            entryPriceUsd: position.entryPriceUsd,
            currentPriceUsd: position.currentPriceUsd,
            highestPriceUsd: position.highestPriceUsd,
            activationPercent: trailing.activationPercent,
            distancePercent: trailing.distancePercent,
            openedAt: position.openedAt,
            stats: this.winRateSnapshot(),
          }),
        );
      }

      if (this.hasPendingForToken(key)) {
        await this.store.save();
        return;
      }

      const action = this.strategy.evaluatePosition(position);
      if (action.type === "TP") {
        await this.sellPartial(position, action.sellPercent);
        return;
      }
      if (action.type === "TRAIL") {
        await this.sellAll(position, "TRAIL");
        return;
      }
      if (action.type === "STOP") {
        await this.sellAll(position, "STOP");
        return;
      }
      if (action.type === "TIME") {
        await this.closeExpired(position);
        return;
      }

      if (position.highestPriceUsd !== previousHigh) {
        await this.store.save();
      }
    });
  }

  /** Return a human-readable snapshot suitable for console/Telegram output. */
  getStats(): EngineStats {
    const state = this.store.data;
    let unrealizedPnlBase = 0;
    let positionEquityBase = 0;

    for (const position of Object.values(state.positions)) {
      if (position.entryPriceUsd <= 0 || position.currentPriceUsd <= 0) continue;

      const cost = Number(toBigInt(position.costBaseRaw, "position.costBaseRaw"));
      const markValue =
        cost * (position.currentPriceUsd / position.entryPriceUsd);
      unrealizedPnlBase += markValue - cost;
      positionEquityBase += markValue;
    }

    const balanceBase = Number(toBigInt(state.balanceBaseRaw, "balanceBaseRaw"));
    const realizedPnlBase = Number(
      toSignedBigInt(state.realizedPnlBaseRaw, "realizedPnlBaseRaw"),
    );
    const networkFeesNative = Number(
      toBigInt(state.networkFeesNativeRaw, "networkFeesNativeRaw"),
    );
    // When the trading base is the native asset (Arc/USDC), gas has already
    // reduced balanceBaseRaw and must not be subtracted from PnL again.
    const gasInBase = this.config.chain.baseIsNative
      ? 0
      : networkFeesNative * this.config.chain.nativeToBaseRate;
    const equityBase = balanceBase + positionEquityBase;
    const netPnlBase = realizedPnlBase + unrealizedPnlBase - gasInBase;

    const closedTrades = state.wins + state.losses;
    const winRate = closedTrades === 0 ? 0 : (state.wins / closedTrades) * 100;

    state.peakEquityBase = Math.max(state.peakEquityBase, equityBase);
    state.maxDrawdownBase = Math.max(
      state.maxDrawdownBase,
      Math.max(0, state.peakEquityBase - equityBase),
    );

    return {
      chain: this.config.chain.name,
      mode: this.config.mode,
      baseSymbol: this.config.chain.baseSymbol,
      nativeSymbol: this.config.chain.nativeSymbol,
      balanceBase: balanceBase / 10 ** this.config.chain.baseDecimals,
      balanceNative:
        Number(toBigInt(state.balanceNativeRaw, "balanceNativeRaw")) /
        10 ** this.config.chain.nativeDecimals,
      openPositions: Object.keys(state.positions).length,
      entries: state.entries,
      closedTrades,
      wins: state.wins,
      losses: state.losses,
      winRate,
      realizedPnlBase:
        realizedPnlBase / 10 ** this.config.chain.baseDecimals,
      unrealizedPnlBase:
        unrealizedPnlBase / 10 ** this.config.chain.baseDecimals,
      networkFeesNative:
        networkFeesNative / 10 ** this.config.chain.nativeDecimals,
      netPnlBase: netPnlBase / 10 ** this.config.chain.baseDecimals,
      equityBase: equityBase / 10 ** this.config.chain.baseDecimals,
      peakEquityBase:
        state.peakEquityBase / 10 ** this.config.chain.baseDecimals,
      maxDrawdownBase:
        state.maxDrawdownBase / 10 ** this.config.chain.baseDecimals,
      pendingSwaps: Object.keys(state.pendingSwaps).length,
    };
  }

  /** Persist metrics modified by `getStats()`, especially peak/drawdown data. */
  async persistMetrics(): Promise<void> {
    await this.store.save();
  }

  private async quote(params: ZeroExQuoteParams): Promise<ZeroExQuote> {
    return (this.config.quoteFn ?? getZeroExQuote)(params);
  }

  private async getWalletBalances(): Promise<{
    baseRaw: bigint;
    nativeRaw: bigint;
  }> {
    if (this.config.mode === "paper") {
      return {
        baseRaw: toBigInt(this.store.data.balanceBaseRaw, "balanceBaseRaw"),
        nativeRaw: toBigInt(this.store.data.balanceNativeRaw, "balanceNativeRaw"),
      };
    }

    if (!this.wallet) throw new Error("Live engine requires a wallet service");
    return this.wallet.getBalances(this.config.chain);
  }

  private async openPaperPosition(
    signal: Signal,
    key: string,
    quote: Awaited<ReturnType<typeof getZeroExQuote>>,
    networkFee: bigint,
    before: { baseRaw: bigint; nativeRaw: bigint },
  ): Promise<boolean> {
    // Pessimistic fill: assume worst-case slippage execution. The quote's
    // minimum is the on-chain guarantee a live swap would carry, so paper
    // never books a better price than live could lock in.
    const quantity = quote.toTokenAmountMin;
    if (quantity <= 0n) {
      console.log(
        `[ENGINE][${this.config.chain.name}] SKIP ${signal.symbol}: zero output`,
      );
      return false;
    }

    // Live pays an approval transaction whenever it sells an ERC-20 token.
    // Native-base buys (Arc) sell the native asset and need none; ERC-20-base
    // buys do. The approval is modeled at the quoted swap-gas rate, which is
    // an upper bound (a plain approve costs less than a swap) — pessimistic
    // by design.
    const executionFee = this.config.chain.baseIsNative ? networkFee : networkFee * 2n;

    const afterBase = this.config.chain.baseIsNative
      ? before.baseRaw - this.config.buyAmountBaseRaw - executionFee
      : before.baseRaw - this.config.buyAmountBaseRaw;
    const afterNative = this.config.chain.baseIsNative
      ? afterBase
      : before.nativeRaw - executionFee;

    const position: Position = {
      tokenAddress: signal.tokenAddress,
      symbol: signal.symbol,
      name: signal.name || signal.symbol,
      decimals: signal.decimals,
      quantityRaw: quantity.toString(),
      initialQuantityRaw: quantity.toString(),
      // For native-base chains, buy gas is paid from the same balance and is
      // therefore part of the acquisition cost. ERC-20-base gas is tracked
      // separately below. Both include the modeled approval fee above.
      costBaseRaw: (this.config.chain.baseIsNative
        ? this.config.buyAmountBaseRaw + executionFee
        : this.config.buyAmountBaseRaw
      ).toString(),
      realizedPnlBaseRaw: "0",
      entryPriceUsd: signal.priceUsd,
      currentPriceUsd: signal.priceUsd,
      highestPriceUsd: signal.priceUsd,
      feesNativeRaw: executionFee.toString(),
      takeProfitIndex: 0,
      trailingActivated: false,
      openedAt: Date.now(),
      lastActionAt: Date.now(),
      pairAddress: signal.pairAddress,
      signalPairAddress: signal.pairAddress,
      dex: signal.dex || "unknown",
      quoteSymbol: signal.quoteSymbol || this.config.chain.baseSymbol,
      liquidityUsd: signal.liquidityUsd,
      snapshot: { ...signal.snapshot },
      source: signal.source,
    };

    await this.store.update((state) => {
      state.balanceBaseRaw = afterBase.toString();
      state.balanceNativeRaw = afterNative.toString();
      state.networkFeesNativeRaw = (
        toBigInt(state.networkFeesNativeRaw, "networkFeesNativeRaw") + executionFee
      ).toString();
      state.entries += 1;
      state.positions[key] = position;
    });

    console.log(
      `[ENGINE][${this.config.chain.name}] Opened ${signal.symbol} | PAPER | ` +
        `cost ${formatUnits(this.config.buyAmountBaseRaw, this.config.chain.baseDecimals)} ${this.config.chain.baseSymbol}`,
    );
    await this.recordEntry(position, toBigInt(position.costBaseRaw, "position.costBaseRaw"));

    const after: BalanceSnapshot = { baseRaw: afterBase, nativeRaw: afterNative };
    await this.notify(
      buildBuyMessage({
        chain: this.config.chain,
        mode: "paper",
        tokenName: position.name,
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        pairAddress: position.pairAddress,
        dex: position.dex,
        quoteSymbol: position.quoteSymbol,
        liquidityUsd: position.liquidityUsd,
        entryPriceUsd: position.entryPriceUsd,
        quantityRaw: quantity,
        quantityDecimals: position.decimals,
        costBaseRaw: this.config.buyAmountBaseRaw,
        networkFeeRaw: executionFee,
        before,
        after,
        stats: this.winRateSnapshot(),
        tpSummary: this.strategy.getTakeProfitSummary(),
        baseUsdRate: this.config.baseUsdRate,
        source: signal.source,
      }),
    );
    return true;
  }

  private async openLivePosition(
    signal: Signal,
    key: string,
    before: { baseRaw: bigint; nativeRaw: bigint },
    estimatedNetworkFee: bigint,
  ): Promise<boolean> {
    if (!this.wallet) throw new Error("Live engine requires a wallet service");

    const tokenBefore = await this.wallet.getTokenBalance(
      this.config.chain,
      signal.tokenAddress,
    );

    // Write-ahead journal: a PREPARED record hits disk before the wallet
    // submission returns, so a crash between broadcast and result still
    // leaves a recoverable trace (previously that window was unrecorded).
    const submittedAt = Date.now();
    const preparedId = `prepared-buy-${key}-${submittedAt}`;
    const prepared: PendingSwap = {
      id: preparedId,
      hash: "",
      side: "BUY",
      tokenAddress: signal.tokenAddress,
      symbol: signal.symbol,
      tokenName: signal.name || signal.symbol,
      decimals: signal.decimals,
      reason: "ENTRY",
      requestedAmountRaw: this.config.buyAmountBaseRaw.toString(),
      signalPriceUsd: signal.priceUsd,
      beforeBaseRaw: before.baseRaw.toString(),
      beforeNativeRaw: before.nativeRaw.toString(),
      beforeTokenRaw: tokenBefore.toString(),
      estimatedNetworkFeeRaw: estimatedNetworkFee.toString(),
      submittedAt,
      pairAddress: signal.pairAddress,
      dex: signal.dex || "unknown",
      snapshot: { ...signal.snapshot },
      source: signal.source,
      entryLiquidityUsd: signal.liquidityUsd,
      stage: "PREPARED",
      reviewNotified: false,
    };
    await this.store.update((state) => {
      state.pendingSwaps[prepared.id] = prepared;
    });

    let result;
    try {
      result = await this.wallet.submitSwap(this.config.chain, {
        fromToken: this.config.chain.baseToken,
        toToken: signal.tokenAddress,
        fromTokenAmount: this.config.buyAmountBaseRaw,
      });
    } catch (error) {
      const after = await this.wallet.getBalances(this.config.chain).catch(() => before);
      // A failed submission has no confirmed trade amount to subtract; any
      // observed native-balance loss is therefore treated as submission gas.
      // The submission itself may still have broadcast before the transport
      // failed, so the record is retained as UNKNOWN for manual review
      // instead of being dropped.
      const networkFee = this.measureObservedNativeFeeForFailure(before, after, 0n);
      await this.recordFailedLiveGas(networkFee, after, prepared.id, true);
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: signal.symbol,
          tokenAddress: signal.tokenAddress,
          pairAddress: signal.pairAddress,
          dex: signal.dex || "unknown",
          reason: "BUY SUBMISSION",
          amountLabel: `Submission outcome unknown | Gas: ${formatUnits(networkFee, this.config.chain.nativeDecimals)} ${this.config.chain.nativeSymbol}`,
          txHash: prepared.id,
          explorerUrl: this.config.chain.explorerUrl,
          note: "No on-chain id was returned; verify on the explorer. Re-entry stays blocked.",
        }),
      );
      throw error;
    }

    const pending: PendingSwap = {
      id: String(result.id),
      // SwidgeResult.hash is optional until the tx is mined; fall back to the
      // swap id so the journal record always has a displayable reference.
      hash: result.hash ?? String(result.id),
      side: "BUY",
      tokenAddress: signal.tokenAddress,
      symbol: signal.symbol,
      tokenName: signal.name || signal.symbol,
      decimals: signal.decimals,
      reason: "ENTRY",
      requestedAmountRaw: this.config.buyAmountBaseRaw.toString(),
      signalPriceUsd: signal.priceUsd,
      beforeBaseRaw: before.baseRaw.toString(),
      beforeNativeRaw: before.nativeRaw.toString(),
      beforeTokenRaw: tokenBefore.toString(),
      estimatedNetworkFeeRaw: estimatedNetworkFee.toString(),
      submittedAt,
      pairAddress: signal.pairAddress,
      dex: signal.dex || "unknown",
      snapshot: { ...signal.snapshot },
      source: signal.source,
      entryLiquidityUsd: signal.liquidityUsd,
      stage: "SUBMITTED",
      reviewNotified: false,
    };

    await this.store.update((state) => {
      delete state.pendingSwaps[prepared.id];
      state.pendingSwaps[pending.id] = pending;
      state.balanceBaseRaw = before.baseRaw.toString();
      state.balanceNativeRaw = before.nativeRaw.toString();
    });

    await this.notify(
      buildPlumbingMessage({
        chain: this.config.chain,
        mode: "live",
        kind: "BUY_SUBMITTED",
        symbol: signal.symbol,
        tokenAddress: signal.tokenAddress,
        pairAddress: pending.pairAddress,
        dex: pending.dex,
        reason: "BUY",
        amountLabel: `${formatUnits(this.config.buyAmountBaseRaw, this.config.chain.baseDecimals)} ${this.config.chain.baseSymbol} @ $${signal.priceUsd}`,
        txHash: pending.hash,
        explorerUrl: this.config.chain.explorerUrl,
      }),
    );

    try {
      const status = await this.wallet.waitForSwap(this.config.chain, result.id);
      return this.settlePendingSwap(pending, status.status);
    } catch (error) {
      console.error(
        `[ENGINE][${this.config.chain.name}] BUY ${signal.symbol} remains pending after submission: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "BUY_PENDING",
          symbol: signal.symbol,
          tokenAddress: signal.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex,
          reason: "BUY",
          amountLabel: `${formatUnits(this.config.buyAmountBaseRaw, this.config.chain.baseDecimals)} ${this.config.chain.baseSymbol}`,
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
          note: "The transaction remains in the recovery journal.",
        }),
      );
      return false;
    }
  }

  private async sellPartial(position: Position, sellPercent: number): Promise<void> {
    if (sellPercent <= 0) return;
    if (sellPercent >= 100) {
      await this.sellAll(position, "TP");
      return;
    }

    const currentQuantity = toBigInt(position.quantityRaw, "position.quantityRaw");
    const sellQuantity =
      (currentQuantity * BigInt(Math.round(sellPercent))) / 100n;
    if (sellQuantity <= 0n) return;
    await this.sell(position, sellQuantity, "TP");
  }

  private async sellAll(position: Position, reason: string): Promise<void> {
    const quantity = toBigInt(position.quantityRaw, "position.quantityRaw");
    if (quantity <= 0n) return;
    await this.sell(position, quantity, reason);
  }

  /**
   * Time-stop exit for positions held past the configured maximum.
   *
   * Both paper and live exit through the standard 0x sell-quote path, so a
   * paper TIME exit pays the same estimated network fee and realizes the
   * same quote proceeds a live swap would preflight. When no route exists
   * the position stays open in both modes (stranded capital, not fantasy
   * mark-price proceeds).
   */
  private async closeExpired(position: Position): Promise<void> {
    await this.sellAll(position, "TIME");
  }

  private async sell(
    position: Position,
    requestedQuantity: bigint,
    reason: string,
  ): Promise<void> {
    const currentQuantity = toBigInt(position.quantityRaw, "position.quantityRaw");
    if (requestedQuantity <= 0n || requestedQuantity > currentQuantity) return;

    console.log(
      `[ENGINE][${this.config.chain.name}] ${reason} ${position.symbol}`,
    );

    let quote: Awaited<ReturnType<typeof getZeroExQuote>>;
    try {
      quote = await this.quote({
        chainId: this.config.chain.chainId,
        fromToken: position.tokenAddress,
        toToken: this.config.chain.baseToken,
        fromTokenAmount: requestedQuantity,
      });
    } catch (error) {
      this.handleQuoteError("SELL", position.symbol, error);
      return;
    }

    const estimatedNetworkFee = getNetworkFee(quote);
    const before = await this.getWalletBalances();
    const sellPercent = currentQuantity > 0n
      ? Number((requestedQuantity * 100n) / currentQuantity)
      : 100;

    if (this.config.mode === "paper") {
      // Paper sells model approval + swap (see sellPaper); preflight both.
      // Live preflight stays at 1x — settlement measures actual gas.
      const requiredSellGas = estimatedNetworkFee * 2n;
      if (
        this.config.chain.baseIsNative
          ? before.baseRaw < requiredSellGas
          : before.nativeRaw < requiredSellGas
      ) {
        console.log(
          `[ENGINE][${this.config.chain.name}] ${reason} ${position.symbol}: insufficient ${this.config.chain.nativeSymbol} for gas`,
        );
        return;
      }

      await this.sellPaper(
        position,
        requestedQuantity,
        reason,
        sellPercent,
        quote,
        estimatedNetworkFee,
        before,
      );
      return;
    }

    await this.sellLive(position, requestedQuantity, reason, sellPercent, before, estimatedNetworkFee);
  }

  private async sellPaper(
    position: Position,
    requestedQuantity: bigint,
    reason: string,
    sellPercent: number,
    quote: Awaited<ReturnType<typeof getZeroExQuote>>,
    networkFee: bigint,
    before: { baseRaw: bigint; nativeRaw: bigint },
  ): Promise<void> {
    // Pessimistic fill: worst-case slippage proceeds (live on-chain guarantee).
    const proceeds = quote.toTokenAmountMin;
    if (proceeds <= 0n) return;

    // Every position token is an ERC-20, so live always pays an approval tx
    // before the swap. Model it at the quoted swap-gas rate (upper bound).
    const executionFee = networkFee * 2n;

    const exitPriceUsd = position.currentPriceUsd;
    const highestPriceUsd = position.highestPriceUsd;
    const entryPriceUsd = position.entryPriceUsd;
    const openedAt = position.openedAt;
    const meta = this.positionMeta(position);
    const currentQuantity = toBigInt(position.quantityRaw, "position.quantityRaw");
    const currentCost = toBigInt(position.costBaseRaw, "position.costBaseRaw");
    const costSold = (currentCost * requestedQuantity) / currentQuantity;
    // Native-base chains (Arc): gas leaves the same balance the proceeds land
    // in, so realized PnL must be net of gas to match the wallet-equity delta
    // (this is also exactly how live settles, via observed wallet deltas).
    // ERC-20-base gas stays out of realized: getStats() converts and subtracts
    // it separately, so folding it in here would double-count.
    const netProceeds = this.config.chain.baseIsNative ? proceeds - executionFee : proceeds;
    const realizedPnl = netProceeds - costSold;

    const remainingQuantity = currentQuantity - requestedQuantity;
    const remainingCost = currentCost - costSold;
    const key = position.tokenAddress.toLowerCase();

    const afterBase = this.config.chain.baseIsNative
      ? before.baseRaw + netProceeds
      : before.baseRaw + proceeds;
    const afterNative = this.config.chain.baseIsNative
      ? afterBase
      : before.nativeRaw - executionFee;

    const totalPositionPnl = await this.applySellResult(
      position,
      key,
      remainingQuantity,
      remainingCost,
      realizedPnl,
      executionFee,
      afterBase,
      afterNative,
      undefined,
      { reason, exitPriceUsd, sellPercent },
    );

    await this.notify(
      buildExitMessage({
        chain: this.config.chain,
        mode: "paper",
        closed: remainingQuantity === 0n,
        reason,
        tokenName: meta.tokenName,
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        pairAddress: position.pairAddress,
        dex: meta.dex,
        quoteSymbol: meta.quoteSymbol,
        liquidityUsd: position.liquidityUsd,
        entryPriceUsd,
        exitPriceUsd,
        highestPriceUsd,
        sellPercent,
        proceedsBaseRaw: proceeds,
        realizedPnlBaseRaw: realizedPnl,
        totalPositionPnlBaseRaw: totalPositionPnl,
        remainingQuantityRaw: remainingQuantity,
        remainingQuantityDecimals: position.decimals,
        remainingCostBaseRaw: remainingCost,
        networkFeeRaw: executionFee,
        before,
        after: { baseRaw: afterBase, nativeRaw: afterNative },
        openedAt,
        closedAt: Date.now(),
        stats: this.winRateSnapshot(),
        baseUsdRate: this.config.baseUsdRate,
        source: position.source,
      }),
    );

    if (remainingQuantity === 0n) {
      console.log(
        `[ENGINE][${this.config.chain.name}] CLOSED ${position.symbol} | position PnL ${formatUnits(totalPositionPnl, this.config.chain.baseDecimals)} ${this.config.chain.baseSymbol}`,
      );
    }
  }

  private async sellLive(
    position: Position,
    requestedQuantity: bigint,
    reason: string,
    sellPercent: number,
    before: { baseRaw: bigint; nativeRaw: bigint },
    estimatedNetworkFee: bigint,
  ): Promise<void> {
    if (!this.wallet) throw new Error("Live engine requires a wallet service");

    const tokenBefore = await this.wallet.getTokenBalance(
      this.config.chain,
      position.tokenAddress,
    );

    const submittedAt = Date.now();
    const preparedId = `prepared-sell-${position.tokenAddress.toLowerCase()}-${submittedAt}`;
    const prepared: PendingSwap = {
      id: preparedId,
      hash: "",
      side: "SELL",
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      tokenName: position.name || position.symbol,
      decimals: position.decimals,
      reason,
      requestedAmountRaw: requestedQuantity.toString(),
      signalPriceUsd: position.currentPriceUsd,
      beforeBaseRaw: before.baseRaw.toString(),
      beforeNativeRaw: before.nativeRaw.toString(),
      beforeTokenRaw: tokenBefore.toString(),
      estimatedNetworkFeeRaw: estimatedNetworkFee.toString(),
      submittedAt,
      pairAddress: position.pairAddress,
      dex: position.dex || "unknown",
      snapshot: { ...position.snapshot },
      source: position.source,
      entryLiquidityUsd: position.liquidityUsd,
      stage: "PREPARED",
      reviewNotified: false,
    };
    await this.store.update((state) => {
      state.pendingSwaps[prepared.id] = prepared;
    });

    let result;
    try {
      result = await this.wallet.submitSwap(this.config.chain, {
        fromToken: position.tokenAddress,
        toToken: this.config.chain.baseToken,
        fromTokenAmount: requestedQuantity,
      });
    } catch (error) {
      const after = await this.wallet.getBalances(this.config.chain).catch(() => before);
      // No transaction result means no confirmed gas usage; do not invent a fee.
      // The broadcast itself may still have happened, so retain as UNKNOWN.
      const networkFee = this.measureObservedNativeFeeForSell(before, after, 0n);
      await this.recordFailedLiveGas(networkFee, after, prepared.id, true);
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: position.symbol,
          tokenAddress: position.tokenAddress,
          pairAddress: position.pairAddress,
          dex: position.dex || "unknown",
          reason: `${reason} SELL SUBMISSION`,
          amountLabel: `Submission outcome unknown | Gas: ${formatUnits(networkFee, this.config.chain.nativeDecimals)} ${this.config.chain.nativeSymbol}`,
          txHash: prepared.id,
          explorerUrl: this.config.chain.explorerUrl,
          note: "No on-chain id was returned; verify on the explorer. Re-entry stays blocked.",
        }),
      );
      throw error;
    }

    const pending: PendingSwap = {
      id: String(result.id),
      hash: result.hash ?? String(result.id),
      side: "SELL",
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      tokenName: position.name || position.symbol,
      decimals: position.decimals,
      reason,
      requestedAmountRaw: requestedQuantity.toString(),
      signalPriceUsd: position.currentPriceUsd,
      beforeBaseRaw: before.baseRaw.toString(),
      beforeNativeRaw: before.nativeRaw.toString(),
      beforeTokenRaw: tokenBefore.toString(),
      estimatedNetworkFeeRaw: estimatedNetworkFee.toString(),
      submittedAt,
      pairAddress: position.pairAddress,
      dex: position.dex || "unknown",
      snapshot: { ...position.snapshot },
      source: position.source,
      entryLiquidityUsd: position.liquidityUsd,
      stage: "SUBMITTED",
      reviewNotified: false,
    };

    await this.store.update((state) => {
      delete state.pendingSwaps[prepared.id];
      state.pendingSwaps[pending.id] = pending;
      state.balanceBaseRaw = before.baseRaw.toString();
      state.balanceNativeRaw = before.nativeRaw.toString();
    });

    await this.notify(
      buildPlumbingMessage({
        chain: this.config.chain,
        mode: "live",
        kind: "SELL_SUBMITTED",
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        pairAddress: pending.pairAddress,
        dex: pending.dex,
        reason,
        amountLabel: `${formatUnits(requestedQuantity, position.decimals)} ${position.symbol} (${sellPercent}% of position)`,
        txHash: pending.hash,
        explorerUrl: this.config.chain.explorerUrl,
      }),
    );

    try {
      const status = await this.wallet.waitForSwap(this.config.chain, result.id);
      await this.settlePendingSwap(pending, status.status);
    } catch (error) {
      console.error(
        `[ENGINE][${this.config.chain.name}] SELL ${position.symbol} remains pending after submission: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "SELL_PENDING",
          symbol: position.symbol,
          tokenAddress: position.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex,
          reason,
          amountLabel: `${formatUnits(requestedQuantity, position.decimals)} ${position.symbol} (${sellPercent}% of position)`,
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
          note: "The transaction remains in the recovery journal.",
        }),
      );
    }
  }

  /** Finalize one terminal live swap using post-transaction wallet deltas. */
  private async settlePendingSwap(
    pending: PendingSwap,
    status: string,
  ): Promise<boolean> {
    if (!this.wallet) throw new Error("Live engine requires a wallet service");

    const before = {
      baseRaw: toBigInt(pending.beforeBaseRaw, "pending.beforeBaseRaw"),
      nativeRaw: toBigInt(pending.beforeNativeRaw, "pending.beforeNativeRaw"),
    };

    const after = await this.wallet.getBalances(this.config.chain);
    const tokenAfter = await this.wallet.getTokenBalance(
      this.config.chain,
      pending.tokenAddress,
    );
    const tokenBefore = toBigInt(pending.beforeTokenRaw, "pending.beforeTokenRaw");
    const estimatedNetworkFee = toBigInt(
      pending.estimatedNetworkFeeRaw,
      "pending.estimatedNetworkFeeRaw",
    );
    const networkFee = status !== "completed"
      ? this.measureObservedNativeFeeForFailure(before, after, estimatedNetworkFee)
      : pending.side === "BUY"
        ? this.measureObservedNativeFeeForBuy(
            before,
            after,
            toBigInt(pending.requestedAmountRaw, "pending.requestedAmountRaw"),
            estimatedNetworkFee,
          )
        : this.measureObservedNativeFeeForSell(before, after, estimatedNetworkFee);

    if (status !== "completed") {
      await this.recordFailedLiveGas(networkFee, after, pending.id);
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: pending.symbol,
          tokenAddress: pending.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex || "unknown",
          reason: pending.side,
          amountLabel: `Status: ${status || "unknown"} | Gas: ${formatUnits(networkFee, this.config.chain.nativeDecimals)} ${this.config.chain.nativeSymbol}`,
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
        }),
      );
      return false;
    }

    if (pending.side === "BUY") {
      const quantity = positiveDelta(tokenAfter, tokenBefore);
      if (quantity <= 0n) {
        await this.notify(
          buildPlumbingMessage({
            chain: this.config.chain,
            mode: "live",
            kind: "FAILED",
            symbol: pending.symbol,
            tokenAddress: pending.tokenAddress,
            pairAddress: pending.pairAddress,
            dex: pending.dex || "unknown",
            reason: "BUY RECONCILIATION",
            amountLabel: "No token delta observed",
            txHash: pending.hash,
            explorerUrl: this.config.chain.explorerUrl,
            note: "Pending record retained for manual/retry reconciliation.",
          }),
        );
        return false;
      }

      // On native-base chains (Arc), this includes gas paid in the base asset.
      // On ERC-20-base chains, this is the exact base-token spend.
      const actualBaseSpent = positiveLoss(before.baseRaw, after.baseRaw);
      const costBaseRaw = actualBaseSpent > 0n
        ? actualBaseSpent.toString()
        : pending.requestedAmountRaw;
      const key = pending.tokenAddress.toLowerCase();
      const position: Position = {
        tokenAddress: pending.tokenAddress,
        symbol: pending.symbol,
        name: pending.tokenName || pending.symbol,
        decimals: pending.decimals,
        quantityRaw: quantity.toString(),
        initialQuantityRaw: quantity.toString(),
        costBaseRaw,
        realizedPnlBaseRaw: "0",
        entryPriceUsd: pending.signalPriceUsd,
        currentPriceUsd: pending.signalPriceUsd,
        highestPriceUsd: pending.signalPriceUsd,
        feesNativeRaw: networkFee.toString(),
        takeProfitIndex: 0,
        trailingActivated: false,
        openedAt: pending.submittedAt,
        lastActionAt: Date.now(),
        pairAddress: pending.pairAddress,
        signalPairAddress: pending.pairAddress,
        dex: pending.dex || "unknown",
        quoteSymbol: this.config.chain.baseSymbol,
        liquidityUsd: pending.entryLiquidityUsd,
        snapshot: pending.snapshot ?? emptySnapshot(),
        source: pending.source || "unknown",
      };

      await this.store.update((state) => {
        state.balanceBaseRaw = after.baseRaw.toString();
        state.balanceNativeRaw = after.nativeRaw.toString();
        state.networkFeesNativeRaw = (
          toBigInt(state.networkFeesNativeRaw, "networkFeesNativeRaw") + networkFee
        ).toString();
        state.entries += 1;
        state.positions[key] = position;
        delete state.pendingSwaps[pending.id];
        state.lastWalletSyncAt = Date.now();
      });

      console.log(
        `[ENGINE][${this.config.chain.name}] Opened ${pending.symbol} | LIVE | tx ${pending.hash}`,
      );
      await this.recordEntry(position, toBigInt(position.costBaseRaw, "position.costBaseRaw"));
      await this.notify(
        buildBuyMessage({
          chain: this.config.chain,
          mode: "live",
          tokenName: position.name,
          symbol: position.symbol,
          tokenAddress: position.tokenAddress,
          pairAddress: position.pairAddress,
          dex: position.dex,
          quoteSymbol: position.quoteSymbol,
          liquidityUsd: position.liquidityUsd,
          entryPriceUsd: position.entryPriceUsd,
          quantityRaw: quantity,
          quantityDecimals: position.decimals,
          costBaseRaw: BigInt(costBaseRaw),
          networkFeeRaw: networkFee,
          before,
          after,
          stats: this.winRateSnapshot(),
          tpSummary: this.strategy.getTakeProfitSummary(),
          baseUsdRate: this.config.baseUsdRate,
          source: position.source,
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
        }),
      );
      return true;
    }

    const position = this.store.data.positions[pending.tokenAddress.toLowerCase()];
    if (!position) {
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: pending.symbol,
          tokenAddress: pending.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex || "unknown",
          reason: "SELL RECONCILIATION",
          amountLabel: "No matching open position",
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
          note: "No matching open position exists. Pending record retained.",
        }),
      );
      return false;
    }

    const soldQuantity = positiveLoss(tokenBefore, tokenAfter);
    const requestedQuantity = toBigInt(
      pending.requestedAmountRaw,
      "pending.requestedAmountRaw",
    );
    if (soldQuantity <= 0n || soldQuantity > requestedQuantity) {
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: pending.symbol,
          tokenAddress: pending.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex || "unknown",
          reason: "SELL RECONCILIATION",
          amountLabel: "Quantity mismatch",
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
          note: "Pending record retained.",
        }),
      );
      return false;
    }

    // The wallet delta is already net of gas when the base asset is native.
    // For ERC-20-base chains, gas is paid separately in the native asset.
    const proceeds = positiveDelta(after.baseRaw, before.baseRaw);
    if (proceeds <= 0n) {
      await this.notify(
        buildPlumbingMessage({
          chain: this.config.chain,
          mode: "live",
          kind: "FAILED",
          symbol: pending.symbol,
          tokenAddress: pending.tokenAddress,
          pairAddress: pending.pairAddress,
          dex: pending.dex || "unknown",
          reason: "SELL PROCEEDS RECONCILIATION",
          amountLabel: "No base proceeds observed",
          txHash: pending.hash,
          explorerUrl: this.config.chain.explorerUrl,
          note: "Pending record retained.",
        }),
      );
      return false;
    }

    const currentQuantity = toBigInt(position.quantityRaw, "position.quantityRaw");
    const currentCost = toBigInt(position.costBaseRaw, "position.costBaseRaw");
    const costSold = (currentCost * soldQuantity) / currentQuantity;
    const realizedPnl = proceeds - costSold;
    const remainingQuantity = currentQuantity - soldQuantity;
    const liveRemainingCost = currentCost - costSold;
    const key = position.tokenAddress.toLowerCase();
    const exitPriceUsd = position.currentPriceUsd > 0 ? position.currentPriceUsd : pending.signalPriceUsd;
    const sellPercent = currentQuantity > 0n ? Number((soldQuantity * 100n) / currentQuantity) : 100;
    const meta = this.positionMeta(position);
    const totalPositionPnl = await this.applySellResult(
      position,
      key,
      remainingQuantity,
      liveRemainingCost,
      realizedPnl,
      networkFee,
      after.baseRaw,
      after.nativeRaw,
      pending.id,
      { reason: pending.reason, exitPriceUsd, sellPercent },
    );

    await this.notify(
      buildExitMessage({
        chain: this.config.chain,
        mode: "live",
        closed: remainingQuantity === 0n,
        reason: pending.reason,
        tokenName: meta.tokenName,
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        pairAddress: position.pairAddress,
        dex: meta.dex,
        quoteSymbol: meta.quoteSymbol,
        liquidityUsd: position.liquidityUsd,
        entryPriceUsd: position.entryPriceUsd,
        exitPriceUsd,
        highestPriceUsd: position.highestPriceUsd,
        sellPercent,
        proceedsBaseRaw: proceeds,
        realizedPnlBaseRaw: realizedPnl,
        totalPositionPnlBaseRaw: totalPositionPnl,
        remainingQuantityRaw: remainingQuantity,
        remainingQuantityDecimals: position.decimals,
        remainingCostBaseRaw: liveRemainingCost,
        networkFeeRaw: networkFee,
        before,
        after,
        openedAt: position.openedAt,
        closedAt: Date.now(),
        stats: this.winRateSnapshot(),
        baseUsdRate: this.config.baseUsdRate,
        source: position.source,
        txHash: pending.hash,
        explorerUrl: this.config.chain.explorerUrl,
      }),
    );

    if (remainingQuantity === 0n) {
      console.log(
        `[ENGINE][${this.config.chain.name}] CLOSED ${position.symbol} | position PnL ${formatUnits(totalPositionPnl, this.config.chain.baseDecimals)} ${this.config.chain.baseSymbol}`,
      );
    }
    return true;
  }

  /** Apply one exit atomically and return cumulative PnL for the position. */
  private async applySellResult(
    position: Position,
    key: string,
    remainingQuantity: bigint,
    remainingCost: bigint,
    realizedPnl: bigint,
    networkFee: bigint,
    afterBase: bigint,
    afterNative: bigint,
    pendingId?: string,
    exit?: { reason: string; exitPriceUsd: number | null; sellPercent: number },
  ): Promise<bigint> {
    const existingPositionPnl = toSignedBigInt(
      position.realizedPnlBaseRaw,
      "position.realizedPnlBaseRaw",
    );
    const totalPositionPnl = existingPositionPnl + realizedPnl;

    await this.store.update((state) => {
      state.balanceBaseRaw = afterBase.toString();
      state.balanceNativeRaw = afterNative.toString();
      state.realizedPnlBaseRaw = (
        toSignedBigInt(state.realizedPnlBaseRaw, "realizedPnlBaseRaw") + realizedPnl
      ).toString();
      state.networkFeesNativeRaw = (
        toBigInt(state.networkFeesNativeRaw, "networkFeesNativeRaw") + networkFee
      ).toString();
      state.lastWalletSyncAt = Date.now();

      if (remainingQuantity === 0n) {
        if (totalPositionPnl > 0n) state.wins += 1;
        else state.losses += 1;
        delete state.positions[key];
        if (pendingId) delete state.pendingSwaps[pendingId];
        return;
      }

      position.quantityRaw = remainingQuantity.toString();
      position.costBaseRaw = remainingCost.toString();
      position.realizedPnlBaseRaw = totalPositionPnl.toString();
      position.feesNativeRaw = (
        toBigInt(position.feesNativeRaw, "position.feesNativeRaw") + networkFee
      ).toString();
      position.takeProfitIndex += 1;
      position.lastActionAt = Date.now();
      state.positions[key] = position;
      if (pendingId) delete state.pendingSwaps[pendingId];
    });

    const decimals = this.config.chain.baseDecimals;
    await this.history()?.recordExit({
      chain: this.config.chain.name,
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      openedAt: position.openedAt,
      reason: exit?.reason ?? "unknown",
      sellPercent: exit?.sellPercent ?? (remainingQuantity === 0n ? 100 : 0),
      exitPriceUsd: exit?.exitPriceUsd ?? null,
      realizedPnlRaw: realizedPnl.toString(),
      realizedPnlDisplay: Number(formatUnits(realizedPnl, decimals)),
      totalPnlRaw: totalPositionPnl.toString(),
      totalPnlDisplay: Number(formatUnits(totalPositionPnl, decimals)),
      closed: remainingQuantity === 0n,
      eventAt: Date.now(),
    });

    return totalPositionPnl;
  }

  /** Estimate native gas for a live buy from observed balances, with quote fallback. */
  private measureObservedNativeFeeForBuy(
    before: { baseRaw: bigint; nativeRaw: bigint },
    after: { baseRaw: bigint; nativeRaw: bigint },
    requestedBaseAmount: bigint,
    estimatedNetworkFee: bigint,
  ): bigint {
    if (!this.config.chain.baseIsNative) {
      const observed = positiveLoss(before.nativeRaw, after.nativeRaw);
      return observed > 0n ? observed : estimatedNetworkFee;
    }

    const nativeSpent = positiveLoss(before.nativeRaw, after.nativeRaw);
    if (nativeSpent <= requestedBaseAmount) return estimatedNetworkFee;
    return nativeSpent - requestedBaseAmount;
  }

  /** Measure gas for a terminal failed transaction from the observed native balance loss. */
  private measureObservedNativeFeeForFailure(
    before: { baseRaw: bigint; nativeRaw: bigint },
    after: { baseRaw: bigint; nativeRaw: bigint },
    estimatedNetworkFee: bigint,
  ): bigint {
    const observed = positiveLoss(before.nativeRaw, after.nativeRaw);
    return observed > 0n ? observed : estimatedNetworkFee;
  }

  /** Estimate live sell gas; native-base sells use the preflight quote because the receipt is netted into proceeds. */
  private measureObservedNativeFeeForSell(
    before: { baseRaw: bigint; nativeRaw: bigint },
    after: { baseRaw: bigint; nativeRaw: bigint },
    estimatedNetworkFee: bigint,
  ): bigint {
    if (!this.config.chain.baseIsNative) {
      const observed = positiveLoss(before.nativeRaw, after.nativeRaw);
      return observed > 0n ? observed : estimatedNetworkFee;
    }
    return estimatedNetworkFee;
  }

  /** Record gas consumed by a live transaction whose trade result was unusable. */
  private async recordFailedLiveGas(
    networkFee: bigint,
    after: { baseRaw: bigint; nativeRaw: bigint },
    pendingId?: string,
    markUnknown = false,
  ): Promise<void> {
    await this.store.update((state) => {
      state.balanceBaseRaw = after.baseRaw.toString();
      state.balanceNativeRaw = after.nativeRaw.toString();
      state.networkFeesNativeRaw = (
        toBigInt(state.networkFeesNativeRaw, "networkFeesNativeRaw") + networkFee
      ).toString();
      // On native-base chains a failed transaction has no position cost or
      // sale proceeds in which to absorb the gas, so charge it directly to
      // realized PnL. This avoids silently dropping failed-tx gas from net PnL.
      if (this.config.chain.baseIsNative && networkFee > 0n) {
        state.realizedPnlBaseRaw = (
          toSignedBigInt(state.realizedPnlBaseRaw, "realizedPnlBaseRaw") - networkFee
        ).toString();
      }
      if (pendingId) {
        if (markUnknown) {
          // The broadcast may still have happened: retain the record as
          // UNKNOWN for manual review instead of dropping the window.
          const record = state.pendingSwaps[pendingId];
          if (record) {
            record.stage = "UNKNOWN";
            record.reviewNotified = false;
          }
        } else {
          delete state.pendingSwaps[pendingId];
        }
      }
      state.lastWalletSyncAt = Date.now();
    });
  }

  /** Keep quote failures non-fatal so one illiquid Debot token cannot stop the bot. */
  private handleQuoteError(side: "BUY" | "SELL", symbol: string, error: unknown): void {
    if (error instanceof ZeroExQuoteError) {
      console.log(
        `[ENGINE][${this.config.chain.name}] SKIP ${side} ${symbol}: ${error.code} — ${error.message}`,
      );
      return;
    }

    console.error(
      `[ENGINE][${this.config.chain.name}] ${side} ${symbol} unexpected 0x error:`,
      error,
    );
  }
}
