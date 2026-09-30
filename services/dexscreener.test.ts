import { describe, expect, test } from "bun:test";

import {
  groupPricesByToken,
  selectTokenPrice,
  type TokenPrice,
} from "./dexscreener";

function price(overrides: Partial<TokenPrice> = {}): TokenPrice {
  return {
    tokenAddress: "0xtoken",
    pairAddress: "0xpair1",
    dexId: "argus",
    symbol: "TEST",
    quoteSymbol: "USDC",
    priceUsd: 1,
    priceNative: null,
    liquidityUsd: 1000,
    ...overrides,
  };
}

describe("selectTokenPrice", () => {
  test("returns null for no pairs", () => {
    expect(selectTokenPrice([])).toBeNull();
  });

  test("prefers the signal pair when it reports a price", () => {
    const pairs = [
      price({ pairAddress: "0xrich", liquidityUsd: 999_999 }),
      price({ pairAddress: "0xsignal", liquidityUsd: 10 }),
    ];
    expect(selectTokenPrice(pairs, "0xsignal")?.pairAddress).toBe("0xsignal");
  });

  test("falls back to highest liquidity when the signal pair is stale", () => {
    const pairs = [
      price({ pairAddress: "0xthin", liquidityUsd: 10 }),
      price({ pairAddress: "0xrich", liquidityUsd: 999_999 }),
      price({ pairAddress: "0xstale", liquidityUsd: 50_000, priceUsd: null }),
    ];
    expect(selectTokenPrice(pairs, "0xstale")?.pairAddress).toBe("0xrich");
  });

  test("falls back to first priced pair without liquidity data", () => {
    const pairs = [
      price({ pairAddress: "0xfirst", liquidityUsd: null }),
      price({ pairAddress: "0xsecond", liquidityUsd: null }),
    ];
    expect(selectTokenPrice(pairs)?.pairAddress).toBe("0xfirst");
  });
});

describe("groupPricesByToken", () => {
  test("emits one price per token, case-insensitively", () => {
    const prices = [
      price({ tokenAddress: "0xAAA", pairAddress: "0xp1", liquidityUsd: 5 }),
      price({ tokenAddress: "0xaaa", pairAddress: "0xp2", liquidityUsd: 500 }),
      price({ tokenAddress: "0xbbb", pairAddress: "0xp3", liquidityUsd: 1 }),
    ];
    const grouped = groupPricesByToken(prices);
    expect(grouped).toHaveLength(2);
    expect(
      grouped.find((p) => p.tokenAddress.toLowerCase() === "0xaaa")?.pairAddress,
    ).toBe("0xp2");
  });

  test("honors per-token preferred pairs", () => {
    const prices = [
      price({ tokenAddress: "0xaaa", pairAddress: "0xrich", liquidityUsd: 999 }),
      price({ tokenAddress: "0xaaa", pairAddress: "0xsignal", liquidityUsd: 1 }),
    ];
    const grouped = groupPricesByToken(
      prices,
      new Map([["0xaaa", "0xsignal"]]),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.pairAddress).toBe("0xsignal");
  });
});
