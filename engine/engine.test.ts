import { describe, expect, test } from "bun:test";

import { createStateStore } from "./store";
import { TradingEngine } from "./engine";
import { Strategy } from "./strategy";
import { emptySnapshot } from "./types";
import type { Signal } from "./types";
import type { ChainConfig } from "../services/config";

const chain: ChainConfig = {
  key: "ARC",
  name: "Arc",
  chainId: 5042,
  debotChain: "arc",
  signalSources: ["dashboard"],
  debotColumns: ["new"],
  debotMemeTypes: [],
  dexScreenerChain: "arc",
  dexpaprikaNetwork: "arc",
  rpcUrl: "https://example.invalid",
  baseToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  baseSymbol: "USDC",
  baseDecimals: 18,
  baseIsNative: true,
  nativeSymbol: "USDC",
  nativeDecimals: 18,
  nativeToBaseRate: 1,
  explorerUrl: "https://example.invalid/tx/",
  minLiquidityUsd: 0,
  minVolumeUsd24h: 0,
  minTxns24h: 0,
  allowUnverifiedSnapshot: false,
};

describe("TradingEngine time-stop", () => {
  test("closes an overstayed paper position via the 0x sell-quote path", async () => {
    const dir = `/tmp/opencode/engine-time-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });

    const messages: string[] = [];
    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 30,
        trailingDistancePercent: 10,
        maxHoldMs: 1000,
        stopLossPercent: 25,
      }),
      {
        chain,
        mode: "paper",
        buyAmountBaseRaw: 10n * 10n ** 18n,
        maxOpenPositions: 3,
        maxDailyLossPct: 0,
        baseUsdRate: 1,
        // Stub 0x quote: indicative 12 USDC but guaranteed minimum 11 USDC,
        // zero gas. Paper must settle the pessimistic minimum.
        quoteFn: async () => ({
          fromTokenAmount: 1000n,
          toTokenAmount: 12n * 10n ** 18n,
          toTokenAmountMin: 11n * 10n ** 18n,
          fees: [],
          priceImpact: undefined,
        }),
      },
      undefined,
      async (message) => {
        messages.push(message);
      },
    );

    const openedAt = Date.now() - 5000;
    await store.update((state) => {
      state.positions["0xtoken"] = {
        tokenAddress: "0xtoken",
        symbol: "OLD",
        name: "Old Token",
        decimals: 18,
        quantityRaw: "1000",
        initialQuantityRaw: "1000",
        costBaseRaw: (10n * 10n ** 18n).toString(),
        realizedPnlBaseRaw: "0",
        entryPriceUsd: 100,
        currentPriceUsd: 100,
        highestPriceUsd: 100,
        feesNativeRaw: "0",
        takeProfitIndex: 0,
        trailingActivated: false,
        openedAt,
        lastActionAt: openedAt,
        pairAddress: "0xpair",
        dex: "argus",
        quoteSymbol: "USDC",
        liquidityUsd: null,
        snapshot: emptySnapshot(),
        source: "debot-dashboard",
      };
    });

    // +10% move after the hold expired: TIME exit via quote, not TP (needs +25%).
    await engine.onPrice({
      tokenAddress: "0xtoken",
      symbol: "OLD",
      pairAddress: "0xpair",
      dexId: "argus",
      quoteSymbol: "USDC",
      priceUsd: 110,
      priceNative: null,
      liquidityUsd: null,
    });

    expect(store.data.positions["0xtoken"]).toBeUndefined();
    expect(store.data.losses).toBe(0);
    expect(store.data.wins).toBe(1);
    // Proceeds = guaranteed minimum 11 USDC (not indicative 12) → 100 + 11.
    expect(store.data.balanceBaseRaw).toBe((111n * 10n ** 18n).toString());
    const close = messages.find((m) => m.includes("TIME"));
    expect(close).toBeDefined();
    expect(close).toContain("Debot dashboard");
    expect(close).toContain("0xtoken");
  });

  test("paper sell pays swap + approval gas at the quoted rate", async () => {
    const dir = `/tmp/opencode/engine-feefull-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });

    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 30,
        trailingDistancePercent: 10,
        maxHoldMs: 1000,
        stopLossPercent: 25,
      }),
      {
        chain,
        mode: "paper",
        buyAmountBaseRaw: 10n * 10n ** 18n,
        maxOpenPositions: 3,
        maxDailyLossPct: 0,
        baseUsdRate: 1,
        // 1 USDC quoted gas; paper sell must deduct 2x (swap + approval).
        quoteFn: async () => ({
          fromTokenAmount: 1000n,
          toTokenAmount: 11n * 10n ** 18n,
          toTokenAmountMin: 11n * 10n ** 18n,
          fees: [{ type: "network", amount: 10n ** 18n, token: "USDC" }],
          priceImpact: undefined,
        }),
      },
      undefined,
      async () => undefined,
    );

    const openedAt = Date.now() - 5000;
    await store.update((state) => {
      state.positions["0xtoken"] = {
        tokenAddress: "0xtoken",
        symbol: "OLD",
        name: "Old Token",
        decimals: 18,
        quantityRaw: "1000",
        initialQuantityRaw: "1000",
        costBaseRaw: (10n * 10n ** 18n).toString(),
        realizedPnlBaseRaw: "0",
        entryPriceUsd: 100,
        currentPriceUsd: 100,
        highestPriceUsd: 100,
        feesNativeRaw: "0",
        takeProfitIndex: 0,
        trailingActivated: false,
        openedAt,
        lastActionAt: openedAt,
        pairAddress: "0xpair",
        dex: "argus",
        quoteSymbol: "USDC",
        liquidityUsd: null,
        snapshot: emptySnapshot(),
        source: "debot-dashboard",
      };
    });

    await engine.onPrice({
      tokenAddress: "0xtoken",
      symbol: "OLD",
      pairAddress: "0xpair",
      dexId: "argus",
      quoteSymbol: "USDC",
      priceUsd: 110,
      priceNative: null,
      liquidityUsd: null,
    });

    expect(store.data.positions["0xtoken"]).toBeUndefined();
    // 100 + 11 proceeds − 2 gas = 109.
    expect(store.data.balanceBaseRaw).toBe((109n * 10n ** 18n).toString());
    expect(store.data.networkFeesNativeRaw).toBe((2n * 10n ** 18n).toString());
  });

  test("stop-loss exits a −30% position through the quote path", async () => {
    const dir = `/tmp/opencode/engine-stop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });

    const messages: string[] = [];
    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 30,
        trailingDistancePercent: 10,
        maxHoldMs: 3_600_000,
        stopLossPercent: 25,
      }),
      {
        chain,
        mode: "paper",
        buyAmountBaseRaw: 10n * 10n ** 18n,
        maxOpenPositions: 3,
        maxDailyLossPct: 0,
        baseUsdRate: 1,
        quoteFn: async () => ({
          fromTokenAmount: 1000n,
          toTokenAmount: 7n * 10n ** 18n,
          toTokenAmountMin: 7n * 10n ** 18n,
          fees: [],
          priceImpact: undefined,
        }),
      },
      undefined,
      async (message) => {
        messages.push(message);
      },
    );

    // Fresh position (no TIME trigger), down 30% past the −25% stop.
    const openedAt = Date.now() - 60_000;
    await store.update((state) => {
      state.positions["0xtoken"] = {
        tokenAddress: "0xtoken",
        symbol: "DUMP",
        name: "Dump Token",
        decimals: 18,
        quantityRaw: "1000",
        initialQuantityRaw: "1000",
        costBaseRaw: (10n * 10n ** 18n).toString(),
        realizedPnlBaseRaw: "0",
        entryPriceUsd: 100,
        currentPriceUsd: 100,
        highestPriceUsd: 100,
        feesNativeRaw: "0",
        takeProfitIndex: 0,
        trailingActivated: false,
        openedAt,
        lastActionAt: openedAt,
        pairAddress: "0xpair",
        dex: "argus",
        quoteSymbol: "USDC",
        liquidityUsd: 50000,
        snapshot: emptySnapshot(),
        source: "debot-dashboard",
      };
    });

    await engine.onPrice({
      tokenAddress: "0xtoken",
      symbol: "DUMP",
      pairAddress: "0xpair",
      dexId: "argus",
      quoteSymbol: "USDC",
      priceUsd: 70,
      priceNative: null,
      liquidityUsd: null,
    });

    expect(store.data.positions["0xtoken"]).toBeUndefined();
    expect(store.data.losses).toBe(1);
    // 100 + 7 proceeds − 0 gas = 107.
    expect(store.data.balanceBaseRaw).toBe((107n * 10n ** 18n).toString());
    const close = messages.find((m) => m.includes("STOP"));
    expect(close).toBeDefined();
    expect(close).toContain("STOP CLOSE");
  });

  test("paper buy takes min quantity and native-chain gas only", async () => {
    const dir = `/tmp/opencode/engine-buyfill-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });

    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 30,
        trailingDistancePercent: 10,
        maxHoldMs: 60_000,
        stopLossPercent: 25,
      }),
      {
        chain,
        mode: "paper",
        buyAmountBaseRaw: 10n * 10n ** 18n,
        maxOpenPositions: 3,
        maxDailyLossPct: 0,
        baseUsdRate: 1,
        // Indicative 500 units, guaranteed 495, 1 USDC gas, no approval on Arc.
        quoteFn: async () => ({
          fromTokenAmount: 10n * 10n ** 18n,
          toTokenAmount: 500n * 10n ** 18n,
          toTokenAmountMin: 495n * 10n ** 18n,
          fees: [{ type: "network", amount: 10n ** 18n, token: "USDC" }],
          priceImpact: undefined,
        }),
      },
      undefined,
      async () => undefined,
    );

    const opened = await engine.onSignal({
      tokenAddress: "0xnew",
      symbol: "NEW",
      name: "New Token",
      decimals: 18,
      pairAddress: "0xpair",
      priceUsd: 1,
      dex: "argus",
      quoteSymbol: "USDC",
      liquidityUsd: null,
      snapshot: emptySnapshot(),
      source: "debot-dashboard",
    });

    expect(opened).toBe(true);
    const position = store.data.positions["0xnew"];
    expect(position?.quantityRaw).toBe((495n * 10n ** 18n).toString());
    // 100 − 10 cost − 1 gas (no approval for native-base buys).
    expect(store.data.balanceBaseRaw).toBe((89n * 10n ** 18n).toString());
    expect(position?.costBaseRaw).toBe((11n * 10n ** 18n).toString());
  });
});

describe("TradingEngine entry snapshot gate", () => {
  function gatedChain(overrides: Partial<ChainConfig> = {}): ChainConfig {
    return { ...chain, ...overrides };
  }

  function signal(overrides: Partial<Signal> = {}): Signal {
    return {
      tokenAddress: "0xgate",
      symbol: "GATE",
      name: "Gate Token",
      decimals: 18,
      pairAddress: "0xpair",
      priceUsd: 1,
      dex: "argus",
      quoteSymbol: "USDC",
      liquidityUsd: 50000,
      snapshot: {
        ...emptySnapshot(),
        volumeUsd24h: 20000,
        txns24h: 100,
      },
      source: "debot-dashboard",
      ...overrides,
    };
  }

  async function gateEngine(entryChain: ChainConfig) {
    const dir = `/tmp/opencode/engine-gate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });
    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 30,
        trailingDistancePercent: 10,
        maxHoldMs: 1000,
        stopLossPercent: 25,
      }),
      { chain: entryChain, mode: "paper", buyAmountBaseRaw: 10n * 10n ** 18n, maxOpenPositions: 3, maxDailyLossPct: 0, baseUsdRate: 1 },
      undefined,
      async () => undefined,
    );
    return { engine, store };
  }

  test("skips low-liquidity signals before any quote", async () => {
    const { engine, store } = await gateEngine(gatedChain({ minLiquidityUsd: 20000 }));
    expect(await engine.onSignal(signal({ liquidityUsd: 5000 }))).toBe(false);
    expect(Object.keys(store.data.positions)).toHaveLength(0);
  });

  test("skips unverified snapshots when the gate is enabled", async () => {
    const { engine, store } = await gateEngine(gatedChain({ minVolumeUsd24h: 10000 }));
    expect(
      await engine.onSignal(signal({ snapshot: emptySnapshot(), liquidityUsd: 50000 })),
    ).toBe(false);
    expect(Object.keys(store.data.positions)).toHaveLength(0);
  });

  test("skips low-txn signals", async () => {
    const { engine, store } = await gateEngine(gatedChain({ minTxns24h: 50 }));
    expect(
      await engine.onSignal(
        signal({ snapshot: { ...emptySnapshot(), volumeUsd24h: 20000, txns24h: 3 } }),
      ),
    ).toBe(false);
    expect(Object.keys(store.data.positions)).toHaveLength(0);
  });

  test("measured values still gate when unverified is allowed", async () => {
    const { engine, store } = await gateEngine(
      gatedChain({ minLiquidityUsd: 20000, allowUnverifiedSnapshot: true }),
    );
    expect(await engine.onSignal(signal({ liquidityUsd: 5000 }))).toBe(false);
    expect(Object.keys(store.data.positions)).toHaveLength(0);
  });
});

describe("TradingEngine daily loss halt", () => {
  const today = new Date().toISOString().slice(0, 10);

  function buySignal(): Signal {
    return {
      tokenAddress: "0xhalt",
      symbol: "HALT",
      name: "Halt Token",
      decimals: 18,
      pairAddress: "0xpair",
      priceUsd: 1,
      dex: "argus",
      quoteSymbol: "USDC",
      liquidityUsd: null,
      snapshot: emptySnapshot(),
      source: "debot-dashboard",
    };
  }

  async function haltEngine(realizedPnlRaw: string, riskDay: string, riskBaseline: string) {
    const dir = `/tmp/opencode/engine-halt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const store = await createStateStore({
      file: `${dir}/arc.json`,
      mode: "paper",
      chain: "Arc",
      initialBaseRaw: 100n * 10n ** 18n,
      initialNativeRaw: 100n * 10n ** 18n,
    });
    await store.update((state) => {
      state.realizedPnlBaseRaw = realizedPnlRaw;
      state.riskDay = riskDay;
      state.riskDayStartRealizedPnlRaw = riskBaseline;
    });
    let quotes = 0;
    const engine = new TradingEngine(
      store,
      new Strategy({
        takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
        trailingActivationPercent: 25,
        trailingDistancePercent: 10,
        maxHoldMs: 3_600_000,
        stopLossPercent: 25,
      }),
      {
        chain,
        mode: "paper",
        buyAmountBaseRaw: 10n * 10n ** 18n,
        maxOpenPositions: 3,
        maxDailyLossPct: 20,
        baseUsdRate: 1,
        quoteFn: async () => {
          quotes += 1;
          return {
            fromTokenAmount: 10n * 10n ** 18n,
            toTokenAmount: 500n * 10n ** 18n,
            toTokenAmountMin: 495n * 10n ** 18n,
            fees: [],
            priceImpact: undefined,
          };
        },
      },
      undefined,
      async () => undefined,
    );
    return { engine, store, quotes: () => quotes };
  }

  test("blocks entries at −20% day loss without quoting", async () => {
    const { engine, store, quotes } = await haltEngine(
      (-25n * 10n ** 18n).toString(),
      today,
      "0",
    );
    expect(await engine.onSignal(buySignal())).toBe(false);
    expect(quotes()).toBe(0);
    expect(Object.keys(store.data.positions)).toHaveLength(0);
  });

  test("allows entries below the halt threshold", async () => {
    const { engine, store, quotes } = await haltEngine(
      (-5n * 10n ** 18n).toString(),
      today,
      "0",
    );
    expect(await engine.onSignal(buySignal())).toBe(true);
    expect(quotes()).toBe(1);
    expect(Object.keys(store.data.positions)).toHaveLength(1);
  });

  test("prior-day losses reset the baseline instead of halting", async () => {
    const { engine, store } = await haltEngine(
      (-25n * 10n ** 18n).toString(),
      "2000-01-01",
      "0",
    );
    expect(await engine.onSignal(buySignal())).toBe(true);
    expect(store.data.riskDay).toBe(today);
    expect(store.data.riskDayStartRealizedPnlRaw).toBe((-25n * 10n ** 18n).toString());
  });
});
