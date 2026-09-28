import { describe, expect, test } from "bun:test";

import { createStateStore } from "./store";
import { TradingEngine } from "./engine";
import { Strategy } from "./strategy";
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
