import { describe, expect, test } from "bun:test";

import { Strategy } from "./strategy";
import { emptySnapshot } from "./types";
import type { Position } from "./types";
const strategy = new Strategy({
  takeProfits: [
    { gainPercent: 25, sellPercent: 50 },
    { gainPercent: 50, sellPercent: 100 },
  ],
  trailingActivationPercent: 30,
  trailingDistancePercent: 10,
  maxHoldMs: 86_400_000,
});

function position(overrides: Partial<Position> = {}): Position {
  return {
    tokenAddress: "0xtoken",
    symbol: "TEST",
    name: "Test Token",
    decimals: 18,
    quantityRaw: "100",
    initialQuantityRaw: "100",
    costBaseRaw: "100",
    realizedPnlBaseRaw: "0",
    entryPriceUsd: 100,
    currentPriceUsd: 100,
    highestPriceUsd: 100,
    feesNativeRaw: "0",
    takeProfitIndex: 0,
    trailingActivated: false,
    openedAt: Date.now(),
    lastActionAt: Date.now(),
    pairAddress: "0xpair",
    dex: "uniswap",
    quoteSymbol: "WETH",
    liquidityUsd: 100000,
    snapshot: emptySnapshot(),
    source: "debot-community",
    ...overrides,
  };
}

describe("Strategy", () => {
  test("accepts a signal", () => {
    expect(strategy.evaluateSignal()).toEqual({ type: "BUY" });
  });

  test("takes first partial profit", () => {
    expect(strategy.evaluatePosition(position({ currentPriceUsd: 125 }))).toEqual({
      type: "TP",
      sellPercent: 50,
    });
  });

  test("takes second profit after first exit", () => {
    expect(
      strategy.evaluatePosition(
        position({ currentPriceUsd: 150, takeProfitIndex: 1 }),
      ),
    ).toEqual({ type: "TP", sellPercent: 100 });
  });

  test("activates trailing at threshold", () => {
    expect(
      strategy.shouldActivateTrailing(position({ currentPriceUsd: 130 })),
    ).toBe(true);
  });

  test("trails 10 percent below the high", () => {
    expect(
      strategy.evaluatePosition(
        position({
          currentPriceUsd: 108,
          highestPriceUsd: 120,
          trailingActivated: true,
        }),
      ),
    ).toEqual({ type: "TRAIL" });
  });

  test("time-stops an overstayed position", () => {
    const now = Date.now();
    expect(
      strategy.evaluatePosition(
        position({ currentPriceUsd: 110, openedAt: now - 90_000_000 }),
        now,
      ),
    ).toEqual({ type: "TIME" });
  });

  test("holds a fresh position below all exits", () => {
    const now = Date.now();
    expect(
      strategy.evaluatePosition(position({ openedAt: now - 1_000 }), now),
    ).toEqual({ type: "HOLD" });
  });

  test("take-profit wins over an expired hold", () => {
    const now = Date.now();
    expect(
      strategy.evaluatePosition(
        position({ currentPriceUsd: 125, openedAt: now - 90_000_000 }),
        now,
      ),
    ).toEqual({ type: "TP", sellPercent: 50 });
  });

  test("time-stop disabled at zero", () => {
    const noTime = new Strategy({
      takeProfits: [{ gainPercent: 25, sellPercent: 50 }],
      trailingActivationPercent: 30,
      trailingDistancePercent: 10,
      maxHoldMs: 0,
    });
    const now = Date.now();
    expect(
      noTime.evaluatePosition(position({ openedAt: now - 90_000_000 }), now),
    ).toEqual({ type: "HOLD" });
  });
});
