import { config, formatUnits, getHistoryFile, getStateFile, NATIVE_TOKEN_SENTINEL, parseUnits, type ChainConfig } from "./services/config";
import { DebotAIService, DebotDashboardService, getDebotPriceState } from "./services/debot_ai";
import { getPrices, watchPrices, type TokenPrice } from "./services/dexscreener";
import { getTokenPriceUsd, DexPaprikaPoolService, usdToBaseRaw } from "./services/dexpaprika";
import { createStateStore, type StateStore } from "./engine/store";
import { TradingEngine } from "./engine/engine";
import { Strategy } from "./engine/strategy";
import { EvmWalletService } from "./services/wallet";
import { TelegramService } from "./services/telegram";
import { HistoryService } from "./services/history";
import { emptySnapshot, snapshotNumber, snapshotTimestamp, type Signal } from "./engine/types";

type TrackedSignal = {
  lastSeenAt: number;
  symbol: string;
};

type ChainRuntime = {
  chain: ChainConfig;
  store: StateStore;
  engine: TradingEngine;
  debot: DebotAIService;
  dashboard: DebotDashboardService | null;
  pools: DexPaprikaPoolService | null;
  trackedSignals: Map<string, TrackedSignal>;
  lastEntryAt: Map<string, number>;
  stopPrices: () => void;
  stopDebot: () => void;
};

/** Native base assets that are definitionally worth $1 — no oracle needed. */
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDS", "FDUSD", "TUSD"]);

/** Base symbols covered by Debot's keyless price_state majors feed. */
const PRICE_STATE_ALIASES: Record<string, string> = {
  WETH: "ETHUSDT",
  ETH: "ETHUSDT",
  USDC: "USDCUSDT",
  SOL: "SOLUSDT",
  BTC: "BTCUSDT",
  WBTC: "BTCUSDT",
};

/**
 * Resolve one chain's base-asset USD rate for paper sizing.
 * Order: $1 for native stablecoins (Arc USDC) → Debot price_state majors
 * → DexPaprika → DexScreener. Returns null when no source can price it.
 */
async function resolveBaseUsdRate(chain: ChainConfig): Promise<number | null> {
  if (chain.baseIsNative && STABLECOIN_SYMBOLS.has(chain.baseSymbol.toUpperCase())) return 1;
  if (chain.baseToken.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase()) return null;

  const priceStateKey = PRICE_STATE_ALIASES[chain.baseSymbol.toUpperCase()];
  if (priceStateKey) {
    try {
      const majors = await getDebotPriceState(config.debot.priceStateUrl, config.debot.timeoutMs);
      if (majors[priceStateKey] !== undefined) return majors[priceStateKey] as number;
      console.warn(`[DEBOT][${chain.name}] price_state has no ${priceStateKey}; trying DexPaprika`);
    } catch (error) {
      console.error(
        `[DEBOT][${chain.name}] price_state failed: ${error instanceof Error ? error.message : String(error)}; trying DexPaprika`,
      );
    }
  }

  if (chain.dexpaprikaNetwork) {
    try {
      const price = await getTokenPriceUsd(chain.dexpaprikaNetwork, chain.baseToken, {
        baseUrl: config.dexpaprika.baseUrl,
        apiKey: config.dexpaprika.apiKey || undefined,
        timeoutMs: config.dexpaprika.timeoutMs,
      });
      if (price !== null) return price;
      console.warn(`[DEXPAPRIKA][${chain.name}] no price for base asset; trying DexScreener`);
    } catch (error) {
      console.error(
        `[DEXPAPRIKA][${chain.name}] ${error instanceof Error ? error.message : String(error)}; trying DexScreener`,
      );
    }
  }

  try {
    const prices = await getPrices(chain.dexScreenerChain, [chain.baseToken], {
      baseUrl: config.dexscreener.baseUrl,
      timeoutMs: config.dexscreener.timeoutMs,
      maxAddresses: config.dexscreener.maxAddresses,
    });
    const match = prices.find(
      (item) => item.tokenAddress.toLowerCase() === chain.baseToken.toLowerCase(),
    );
    const price = match?.priceUsd ?? prices[0]?.priceUsd ?? null;
    if (price !== null && price > 0) return price;
  } catch (error) {
    console.error(
      `[DexScreener][${chain.name}] base USD fallback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

/** Build the initial paper balances for one chain. */
async function paperBalances(chain: ChainConfig): Promise<{
  baseRaw: bigint;
  nativeRaw: bigint;
  buyRaw: bigint;
  usdRate: number | null;
}> {
  const legacyBaseRaw = parseUnits(
    config.paper.initialBase,
    chain.baseDecimals,
    "PAPER_INITIAL_BASE",
  );
  const legacyBuyRaw = parseUnits(
    config.risk.buyAmountBase,
    chain.baseDecimals,
    "BUY_AMOUNT_BASE",
  );

  let baseRaw = legacyBaseRaw;
  let buyRaw = legacyBuyRaw;
  let usdRate: number | null = null;

  if (config.paper.initialUsd !== null && config.paper.buyAmountUsd !== null) {
    const rate = await resolveBaseUsdRate(chain);
    if (rate === null) {
      console.warn(
        `[PAPER][${chain.name}] USD pricing unavailable; falling back to PAPER_INITIAL_BASE=${config.paper.initialBase} ${chain.baseSymbol}`,
      );
    } else {
      baseRaw = usdToBaseRaw(Number(config.paper.initialUsd), rate, chain.baseDecimals);
      buyRaw = usdToBaseRaw(Number(config.paper.buyAmountUsd), rate, chain.baseDecimals);
      usdRate = rate;
      console.log(
        `[PAPER][${chain.name}] $${config.paper.initialUsd} → ${formatUnits(baseRaw, chain.baseDecimals)} ${chain.baseSymbol} @ $${rate} | buy $${config.paper.buyAmountUsd} → ${formatUnits(buyRaw, chain.baseDecimals)} ${chain.baseSymbol}`,
      );
    }
  }

  // Arc uses native USDC as both its gas and trading balance. The same raw
  // balance represents both views, so PAPER_INITIAL_NATIVE is intentionally
  // ignored there.
  const nativeRaw = chain.baseIsNative
    ? baseRaw
    : parseUnits(
        config.paper.initialNative,
        chain.nativeDecimals,
        "PAPER_INITIAL_NATIVE",
      );

  return { baseRaw, nativeRaw, buyRaw, usdRate };
}

/** Print one chain's current metrics using human-readable decimal units. */
function printStats(runtime: ChainRuntime): ReturnType<TradingEngine["getStats"]> {
  const stats = runtime.engine.getStats();
  console.log(`\n========== ${runtime.chain.name.toUpperCase()} ==========`);
  console.log(`Mode: ${stats.mode.toUpperCase()}`);
  console.log(`Base: ${stats.balanceBase.toFixed(6)} ${stats.baseSymbol}`);
  console.log(`Native: ${stats.balanceNative.toFixed(6)} ${stats.nativeSymbol}`);
  console.log(`Open positions: ${stats.openPositions}`);
  console.log(`Entries / closed: ${stats.entries} / ${stats.closedTrades}`);
  console.log(`Wins / losses: ${stats.wins} / ${stats.losses}`);
  console.log(`Win rate: ${stats.winRate.toFixed(2)}%`);
  console.log(`Realized PnL: ${stats.realizedPnlBase.toFixed(6)} ${stats.baseSymbol}`);
  console.log(`Unrealized PnL: ${stats.unrealizedPnlBase.toFixed(6)} ${stats.baseSymbol}`);
  console.log(`Network fees: ${stats.networkFeesNative.toFixed(8)} ${stats.nativeSymbol}`);
  console.log(`Net PnL: ${stats.netPnlBase.toFixed(6)} ${stats.baseSymbol}`);
  console.log(`Equity: ${stats.equityBase.toFixed(6)} ${stats.baseSymbol}`);
  console.log(`Max drawdown: ${stats.maxDrawdownBase.toFixed(6)} ${stats.baseSymbol}`);
  return stats;
}

/** Format a compact status line for Telegram. */
function formatStatusLine(stats: ReturnType<TradingEngine["getStats"]>): string {
  return (
    `*${stats.chain}*\n` +
    `Mode: ${stats.mode.toUpperCase()}\n` +
    `Balance: ${stats.balanceBase.toFixed(6)} ${stats.baseSymbol}\n` +
    `Open: ${stats.openPositions} | Entries: ${stats.entries}\n` +
    `W/L: ${stats.wins}/${stats.losses} | Win rate: ${stats.winRate.toFixed(2)}%\n` +
    `Pending: ${stats.pendingSwaps}\n` +
    `Net PnL: ${stats.netPnlBase.toFixed(6)} ${stats.baseSymbol}\n` +
    `Equity: ${stats.equityBase.toFixed(6)} ${stats.baseSymbol}`
  );
}

/** Convert a Debot response item into the engine's normalized signal. */
function normalizeSignal(signal: Awaited<ReturnType<DebotAIService["getRank"]>>[number]): Signal | null {
  if (!signal.address || !signal.symbol || !signal.pair) return null;
  if (!Number.isInteger(signal.decimals) || signal.decimals < 0) return null;
  if (!Number.isFinite(signal.market_info.price) || signal.market_info.price <= 0) return null;

  const liquidity = typeof signal.pair_summary_info?.liquidity === "number" &&
      Number.isFinite(signal.pair_summary_info.liquidity)
    ? signal.pair_summary_info.liquidity
    : null;

  const market = signal.market_info ?? {};
  const snapshot = {
    ...emptySnapshot(),
    volumeUsd24h: snapshotNumber(market.volume),
    txns24h: snapshotNumber(market.swaps),
    buys24h: snapshotNumber(market.buys),
    sells24h: snapshotNumber(market.sells),
    mktCapUsd: snapshotNumber(market.mkt_cap),
    fdvUsd: snapshotNumber(market.fdv),
    holders: snapshotNumber(market.holders),
    poolCreatedAtMs: snapshotTimestamp(signal.creation_timestamp),
  };

  return {
    tokenAddress: signal.address,
    symbol: signal.symbol,
    name: typeof signal.name === "string" && signal.name ? signal.name : signal.symbol,
    decimals: signal.decimals,
    pairAddress: signal.pair,
    priceUsd: signal.market_info.price,
    dex: typeof signal.dex?.dex_name === "string" && signal.dex.dex_name
      ? signal.dex.dex_name
      : "unknown",
    quoteSymbol: typeof signal.base_token?.symbol === "string" ? signal.base_token.symbol : "",
    liquidityUsd: liquidity,
    momentumGainPct1h: null,
    snapshot,
    source: "debot-community",
  };
}

/** Create and start one independent chain runtime. */
async function createRuntime(
  chain: ChainConfig,
  wallet: EvmWalletService | undefined,
  telegram: TelegramService,
  history: HistoryService,
): Promise<ChainRuntime> {
  const paper = await paperBalances(chain);
  const initialBalances = config.mode === "paper"
    ? paper
    : await wallet!.getBalances(chain);

  const store = await createStateStore({
    file: getStateFile(config, chain),
    mode: config.mode,
    chain: chain.name,
    initialBaseRaw: initialBalances.baseRaw,
    initialNativeRaw: initialBalances.nativeRaw,
  });

  const engine = new TradingEngine(
    store,
    new Strategy(config.strategy),
    {
      chain,
      mode: config.mode,
      buyAmountBaseRaw: config.mode === "paper"
        ? paper.buyRaw
        : parseUnits(config.risk.buyAmountBase, chain.baseDecimals, "BUY_AMOUNT_BASE"),
      maxOpenPositions: config.risk.maxOpenPositions,
      maxDailyLossPct: config.risk.maxDailyLossPct,
      staleTimeoutMs: config.strategy.staleTimeoutMs,
      baseUsdRate: config.mode === "paper" ? paper.usdRate : null,
      history,
    },
    wallet,
    (message) => telegram.send(message),
  );

  const debot = new DebotAIService(chain.debotChain, config.debot.timeoutMs, config.debot.baseUrl);
  const dashboard = chain.signalSources.includes("dashboard")
    ? new DebotDashboardService(config.debot.timeoutMs, config.debot.dashboardBaseUrl)
    : null;
  const pools = chain.signalSources.includes("dexpaprika")
    ? new DexPaprikaPoolService(chain.dexpaprikaNetwork || chain.dexScreenerChain, chain.baseToken, chain.baseSymbol, {
        baseUrl: config.dexpaprika.baseUrl,
        apiKey: config.dexpaprika.apiKey || undefined,
        timeoutMs: config.dexpaprika.timeoutMs,
        limit: config.dexpaprika.poolLimit,
        minPoolLiquidityUsd: config.dexpaprika.poolMinLiqUsd,
      })
    : null;
  // Snapshot enricher for price-only dashboard signals. Reuses the signal
  // pool service when present, otherwise a dedicated instance, so enrichment
  // never depends on dexpaprika being an active signal source.
  const snapshots = pools ??
    (chain.dexpaprikaNetwork
      ? new DexPaprikaPoolService(chain.dexpaprikaNetwork, chain.baseToken, chain.baseSymbol, {
          baseUrl: config.dexpaprika.baseUrl,
          apiKey: config.dexpaprika.apiKey || undefined,
          timeoutMs: config.dexpaprika.timeoutMs,
          limit: config.dexpaprika.poolLimit,
          minPoolLiquidityUsd: config.dexpaprika.poolMinLiqUsd,
        })
      : null);
  const snapshotCache = new Map<string, { at: number; liquidityUsd: number | null; volumeUsd24h: number | null; txns24h: number | null; mktCapUsd: number | null; fdvUsd: number | null }>();
  const trackedSignals = new Map<string, TrackedSignal>();
  const lastEntryAt = new Map<string, number>();

  console.log(`[${chain.name}] Signals: ${chain.signalSources.join(", ")}`);
  console.log(
    `[${chain.name}] Momentum override: ${
      chain.momentumOverride
        ? `ON (+${chain.momentumMinGainPct}% 1h, liq ≥ $${chain.momentumMinLiqUsd}, vol waived)`
        : "off"
    }`,
  );

  /**
   * Fetch candidates from every active source as normalized engine signals.
   * Same-poll duplicates resolve to the first-listed source in SIGNAL_SOURCES.
   * One failing source never blocks the others.
   */
  const fetchSignals = async (): Promise<Signal[]> => {
    const collected: Signal[] = [];

    for (const source of chain.signalSources) {
      try {
        if (source === "dashboard" && dashboard) {
          const ranks = await dashboard.getRanks(
            chain.debotColumns,
            config.debot.limit,
            chain.debotMemeTypes,
          );
          if (ranks.length > 0) {
            console.log(`[DEBOT][${chain.name}] dashboard: ${ranks.length} ranks`);
          }
          // Dashboard items carry price only: backfill liq/vol/txns/mcap from
          // DexPaprika (1h cache per token) so entry filters can evaluate them.
          // Complete misses cache only 5 minutes: a token indexed seconds
          // after first sight must not stay "unverified" for a full hour.
          // Enrichment runs in small staggered batches: one Promise.all over
          // all ranks bursts DexPaprika and trades 429s for null snapshots.
          if (snapshots) {
            const readCache = (key: string) => {
              const cached = snapshotCache.get(key);
              const ttl = cached &&
                  (cached.liquidityUsd !== null || cached.volumeUsd24h !== null || cached.txns24h !== null)
                ? 3600_000
                : 300_000;
              return cached && Date.now() - cached.at < ttl ? cached : null;
            };
            const applySnap = (
              rank: (typeof ranks)[number],
              snap: {
                liquidityUsd: number | null;
                volumeUsd24h: number | null;
                txns24h: number | null;
                mktCapUsd: number | null;
                fdvUsd: number | null;
              },
            ) => {
              rank.liquidityUsd = snap.liquidityUsd;
              Object.assign(rank.snapshot, {
                volumeUsd24h: snap.volumeUsd24h,
                txns24h: snap.txns24h,
                mktCapUsd: snap.mktCapUsd,
                fdvUsd: snap.fdvUsd,
              });
            };
            // Batch liveness pre-check: unindexed tokens skip their individual
            // details calls (which would just 404) and cache the miss.
            const uncachedKeys = [...new Set(
              ranks
                .map((rank) => rank.tokenAddress.toLowerCase())
                .filter((key) => !readCache(key)),
            )];
            const indexed = uncachedKeys.length > 0
              ? await snapshots.filterIndexed(uncachedKeys)
              : new Set<string>();
            const ENRICH_BATCH = 5;
            const ENRICH_GAP_MS = 250;
            for (let index = 0; index < ranks.length; index += ENRICH_BATCH) {
              await Promise.all(ranks.slice(index, index + ENRICH_BATCH).map(async (rank) => {
                const key = rank.tokenAddress.toLowerCase();
                const cached = readCache(key);
                if (cached) {
                  applySnap(rank, cached);
                  return;
                }
                if (!indexed.has(key)) {
                  const miss = {
                    at: Date.now(),
                    liquidityUsd: null,
                    volumeUsd24h: null,
                    txns24h: null,
                    mktCapUsd: null,
                    fdvUsd: null,
                  };
                  snapshotCache.set(key, miss);
                  applySnap(rank, miss);
                  return;
                }
                const snap = await snapshots.getTokenSnapshot(rank.tokenAddress);
                snapshotCache.set(key, { at: Date.now(), ...snap });
                applySnap(rank, snap);
              }));
              if (index + ENRICH_BATCH < ranks.length) {
                await new Promise((resolve) => setTimeout(resolve, ENRICH_GAP_MS));
              }
            }
          }
          collected.push(...ranks);
        } else if (source === "dexpaprika" && pools) {
          collected.push(...await pools.getNewPoolSignals());
        } else {
          const rank = await debot.getRank(config.debot.duration, config.debot.limit);
          const community: Signal[] = [];
          for (const candidate of rank) {
            const signal = normalizeSignal(candidate);
            if (signal) community.push(signal);
          }
          if (community.length > 0) {
            console.log(`[DEBOT][${chain.name}] community: ${community.length} ranks`);
          }
          collected.push(...community);
        }
      } catch (error) {
        console.error(
          `[SIGNAL][${chain.name}] ${source} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await telegram.sendError(`Signal ${source}`, chain.name, error).catch(() => undefined);
      }
    }

    const seen = new Set<string>();
    return collected.filter((signal) => {
      const key = signal.tokenAddress.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const refreshSignals = async (): Promise<void> => {
    try {
      const signals = await fetchSignals();
      const now = Date.now();

      for (const signal of signals) {
        const key = signal.tokenAddress.toLowerCase();
        trackedSignals.set(key, { lastSeenAt: now, symbol: signal.symbol });

        const lastEntry = lastEntryAt.get(key) ?? 0;
        if (now - lastEntry < config.risk.signalReentryCooldownMs) continue;

        try {
          const opened = await engine.onSignal(signal);
          const isTracked = engine.getTrackingTokens().some(
            (token) => token.toLowerCase() === key,
          );
          if (opened || isTracked) lastEntryAt.set(key, now);
        } catch (error) {
          console.error(
            `[ENGINE][${chain.name}] signal ${signal.symbol} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      for (const [key, tracked] of trackedSignals) {
        const isOpen = engine.getPositionTokens().some((token) => token.toLowerCase() === key);
        if (!isOpen && now - tracked.lastSeenAt > config.dexscreener.trackedTokenTtlMs) {
          trackedSignals.delete(key);
        }
        const lastEntry = lastEntryAt.get(key);
        if (lastEntry !== undefined && now - lastEntry > config.risk.signalReentryCooldownMs * 2) {
          lastEntryAt.delete(key);
        }
      }
    } catch (error) {
      console.error(
        `[SIGNAL][${chain.name}] loop failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await telegram.sendError("Signal loop", chain.name, error).catch(() => undefined);
    }
  };

  const addressesForPrices = (): string[] => {
    const now = Date.now();
    const addresses = new Set<string>(engine.getTrackingTokens());

    for (const [key, tracked] of trackedSignals) {
      if (now - tracked.lastSeenAt <= config.dexscreener.trackedTokenTtlMs) {
        addresses.add(key);
      }
    }

    return [...addresses];
  };

  const stopPrices = watchPrices(
    chain.dexScreenerChain,
    addressesForPrices,
    config.dexscreener.intervalMs,
    {
      baseUrl: config.dexscreener.baseUrl,
      timeoutMs: config.dexscreener.timeoutMs,
      maxAddresses: config.dexscreener.maxAddresses,
      // Pin each tracked token to its signal pair so exits always evaluate
      // against one deterministic venue per poll.
      preferredPairs: () => engine.getPricePreferences(),
      onUpdate: (prices: TokenPrice[]) => {
        for (const price of prices) {
          if (config.logPrices) {
            console.log(
              `[PRICE][${chain.name}] ${price.symbol} | $${price.priceUsd ?? "N/A"}`,
            );
          }
          void engine.onPrice(price).catch(async (error) => {
            console.error(
              `[ENGINE][${chain.name}] price handling failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            await telegram.sendError("Engine", chain.name, error).catch(() => undefined);
          });
        }
      },
      onError: (error) => {
        console.error(`[DexScreener][${chain.name}] ${error.message}`);
      },
    },
  );

  await engine.reconcilePendingSwaps();
  await refreshSignals();

  const stopDebot = (): void => {
    clearInterval(debotTimer);
  };
  const debotTimer = setInterval(() => void refreshSignals(), config.debot.pollIntervalMs);

  return {
    chain,
    store,
    engine,
    debot,
    dashboard,
    pools,
    trackedSignals,
    lastEntryAt,
    stopPrices,
    stopDebot,
  };
}

/** Main application coordinator for paper and live trading. */
async function main(): Promise<void> {
  console.log("========================================");
  console.log(`EVM Trading Bot v${config.version}`);
  console.log("========================================");
  console.log(`Mode   : ${config.mode.toUpperCase()}`);
  console.log(`Chains : ${config.chains.map((chain) => chain.name).join(", ")}`);
  console.log(
    `Buy    : ${config.paper.buyAmountUsd !== null ? `$${config.paper.buyAmountUsd} (USD)` : config.risk.buyAmountBase}`,
  );
  console.log(`MaxPos : ${config.risk.maxOpenPositions}`);
  console.log(
    `TP     : ${config.strategy.takeProfits.map((tp) => `${tp.gainPercent}%/${tp.sellPercent}%`).join(", ")}`,
  );
  console.log(
    `Trail  : ${config.strategy.trailingActivationPercent}% activation / ${config.strategy.trailingDistancePercent}% distance`,
  );
  console.log(
    `Stop   : ${config.strategy.stopLossPercent > 0 ? `-${config.strategy.stopLossPercent}%` : "disabled"}`,
  );
  console.log(
    `Halt   : ${config.risk.maxDailyLossPct > 0 ? `-${config.risk.maxDailyLossPct}%/day` : "disabled"}`,
  );
  console.log(
    `Stale  : ${config.strategy.staleTimeoutMs > 0 ? `${config.strategy.staleTimeoutMs / 3_600_000}h → $0 (paper)` : "disabled"}`,
  );

  const telegram = new TelegramService(config.telegram);
  await telegram.verify();

  const history = config.history.enabled
    ? await HistoryService.open(getHistoryFile(config))
    : HistoryService.disabled();
  console.log(`History: ${history.enabled ? getHistoryFile(config) : "disabled"}`);

  const startedAt = Date.now();

  const wallet = config.mode === "live"
    ? new EvmWalletService(config.mnemonic, config.walletAccountIndex, config)
    : undefined;

  const runtimes: ChainRuntime[] = [];
  try {
    for (const chain of config.chains) {
      try {
        const runtime = await createRuntime(chain, wallet, telegram, history);
        runtimes.push(runtime);

        const address = config.mode === "live" ? await wallet!.getAddress(chain) : "paper-wallet";
        console.log(`[${chain.name}] Wallet: ${address}`);
        console.log(`[${chain.name}] State: ${getStateFile(config, chain)}`);
      } catch (error) {
        console.error(
          `[STARTUP][${chain.name}] disabled: ${error instanceof Error ? error.message : String(error)}`,
        );
        await telegram.sendError("Startup", chain.name, error).catch(() => undefined);
      }
    }

    if (runtimes.length === 0) {
      throw new Error("No configured chain could be started");
    }

    await telegram.sendStartup({
      mode: config.mode,
      chains: runtimes.map((runtime) => runtime.chain.name),
      version: config.version,
      buyAmountBase: config.paper.buyAmountUsd !== null
        ? `$${config.paper.buyAmountUsd} (USD)`
        : config.risk.buyAmountBase,
      maxOpenPositions: config.risk.maxOpenPositions,
      takeProfitSummary: config.strategy.takeProfits
        .map((tp) => `+${tp.gainPercent}%/${tp.sellPercent}%`)
        .join(", "),
      trailingSummary:
        `+${config.strategy.trailingActivationPercent}% activation / ` +
        `-${config.strategy.trailingDistancePercent}% distance`,
      stopSummary: config.strategy.stopLossPercent > 0
        ? `-${config.strategy.stopLossPercent}%`
        : "disabled",
      haltSummary: config.risk.maxDailyLossPct > 0
        ? `-${config.risk.maxDailyLossPct}%/day`
        : "disabled",
    });

    let statusRunning = false;
    const statusTimer = setInterval(() => {
      if (statusRunning) return;
      statusRunning = true;

      void (async () => {
        try {
          const allStats = [] as ReturnType<TradingEngine["getStats"]>[];
          for (const runtime of runtimes) {
            if (config.mode === "live") {
              await runtime.engine.reconcilePendingSwaps();
              await runtime.engine.syncLiveWallet();
            } else {
              const reaped = await runtime.engine.reapStalePositions();
              if (reaped > 0) {
                console.log(`[${runtime.chain.name}] Reaped ${reaped} stale position(s) at $0`);
              }
            }
            const stats = printStats(runtime);
            await runtime.engine.persistMetrics();
            allStats.push(stats);
          }

          if (config.telegram.enabled && config.telegram.statusEnabled) {
            await telegram.send(
              `*EVM Trading Bot status*\n` +
                `Mode: ${config.mode.toUpperCase()}\n` +
                `Chains: ${runtimes.map((runtime) => runtime.chain.name).join(", ")}\n\n` +
                allStats.map(formatStatusLine).join("\n\n"),
            );
          }
        } catch (error) {
          console.error(`[STATUS] ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          statusRunning = false;
        }
      })();
    }, config.statusIntervalMs);

    const shutdown = async (): Promise<void> => {
      clearInterval(statusTimer);
      for (const runtime of runtimes) {
        runtime.stopDebot();
        runtime.stopPrices();
      }
      wallet?.dispose();
      await telegram.sendShutdown({
        mode: config.mode,
        chains: runtimes.map((runtime) => runtime.chain.name),
        uptimeMs: Date.now() - startedAt,
      }).catch(() => undefined);
      console.log("\nEngine stopped.");
    };

    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
  } catch (error) {
    for (const runtime of runtimes) {
      runtime.stopDebot();
      runtime.stopPrices();
    }
    wallet?.dispose();
    throw error;
  }
}

await main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
