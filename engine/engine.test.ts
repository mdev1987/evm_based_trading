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
  test("closes an overstayed paper position at mark price", async () => {
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
      }),
      { chain, mode: "paper", buyAmountBaseRaw: 10n * 10n ** 18n, maxOpenPositions: 3, baseUsdRate: 1 },
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

    // +10% move after the hold expired: TIME exit at mark, not TP (needs +25%).
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
    // Proceeds = 10 USDC * 110/100 = 11 USDC → balance 100 + 11 = 111.
    expect(store.data.balanceBaseRaw).toBe((111n * 10n ** 18n).toString());
    const close = messages.find((m) => m.includes("TIME"));
    expect(close).toBeDefined();
    expect(close).toContain("Debot dashboard");
    expect(close).toContain("0xtoken");
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
      }),
      { chain: entryChain, mode: "paper", buyAmountBaseRaw: 10n * 10n ** 18n, maxOpenPositions: 3, baseUsdRate: 1 },
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
