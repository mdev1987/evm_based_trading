import { describe, expect, test } from "bun:test";
import { DexPaprikaPoolService, getTokenPriceUsd, usdToBaseRaw } from "./dexpaprika";

describe("usdToBaseRaw", () => {
  test("converts $100 of WETH at $2683.30", () => {
    const rate = 2683.304064941824;
    const raw = usdToBaseRaw(100, rate, 18);
    // ≈ 0.0372674 WETH; allow a few wei of float formatting drift.
    expect(raw > 37267487239530000n && raw < 37267487239600000n).toBe(true);
    const roundTripUsd = (Number(raw) / 1e18) * rate;
    expect(Math.abs(roundTripUsd - 100)).toBeLessThan(0.01);
  });

  test("converts $100 of USDC at $1", () => {
    expect(usdToBaseRaw(100, 1, 18)).toBe(100n * 10n ** 18n);
  });

  test("rejects invalid inputs", () => {
    expect(() => usdToBaseRaw(0, 1, 18)).toThrow();
    expect(() => usdToBaseRaw(-5, 1, 18)).toThrow();
    expect(() => usdToBaseRaw(100, 0, 18)).toThrow();
    expect(() => usdToBaseRaw(Number.NaN, 1, 18)).toThrow();
  });
});

describe("getTokenPriceUsd", () => {
  test("returns null without network or address", async () => {
    expect(await getTokenPriceUsd("", "0xabc")).toBeNull();
    expect(await getTokenPriceUsd("robinhood", "")).toBeNull();
  });

  test("parses summary.price_usd", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ summary: { price_usd: 2683.3 } }), { status: 200 })) as unknown as typeof fetch;
    try {
      expect(await getTokenPriceUsd("robinhood", "0xabc")).toBe(2683.3);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns null for missing/invalid price", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ summary: {} }), { status: 200 })) as unknown as typeof fetch;
    try {
      expect(await getTokenPriceUsd("robinhood", "0xabc")).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on non-2xx", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    try {
      await expect(getTokenPriceUsd("robinhood", "0xabc")).rejects.toThrow("DexPaprika 404");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("sends the key as the whole Authorization value (per DexPaprika docs)", async () => {
    const original = globalThis.fetch;
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen = { ...(init?.headers ?? {}) };
      return new Response(JSON.stringify({ summary: { price_usd: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await getTokenPriceUsd("robinhood", "0xabc", { apiKey: "api_test123" });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen["Authorization"]).toBe("api_test123");
    expect(seen["X-API-Key"]).toBeUndefined();
  });
});

describe("DexPaprikaPoolService", () => {
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const NEW_TOKEN = "0x5eeda514f70559198ca9aa973c1f74b58c0d4f0b";
  const NIL = "0x0000000000000000000000000000000000000000";

  function stubClient(
    pools: unknown[],
    details: Record<string, unknown>,
    multiPrices?: Record<string, unknown> | Error,
  ) {
    let detailCalls = 0;
    let multiCalls = 0;
    const client = {
      pools: {
        listByNetwork: async () => ({ results: pools }),
      },
      tokens: {
        getDetails: async (_network: string, address: string) => {
          detailCalls += 1;
          const hit = details[address.toLowerCase()];
          if (!hit) throw new Error("not found");
          return hit;
        },
        getMultiPrices: async (_network: string, tokens: string[]) => {
          multiCalls += 1;
          if (multiPrices instanceof Error) throw multiPrices;
          const known = multiPrices ?? {};
          return tokens
            .filter((token) => known[token.toLowerCase()] !== undefined)
            .map((token) => ({
              chain: "arc",
              id: token,
              price_usd: 1,
              last_updated: "2026-10-01T00:00:00Z",
            }));
        },
      },
    };
    return {
      client: client as never,
      calls: () => detailCalls,
      multiCalls: () => multiCalls,
    };
  }

  const arcPool = {
    id: "0xpool1",
    dex_id: "uniswap_v4",
    dex_name: "Uniswap V4",
    chain: "arc",
    price_usd: 0.000007672555179704672,
    liquidity_usd: 27376.16,
    tokens: [{ id: NIL }, { id: NEW_TOKEN }],
  };

  const tokenDetails = {
    symbol: "NEW",
    name: "New Token",
    decimals: 18,
    summary: { price_usd: 0.000007 },
  };

  test("normalizes an Arc pool with native placeholder leg", async () => {
    const { client } = stubClient([], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    const signal = await service.normalizePool(arcPool as never);
    expect(signal?.tokenAddress).toBe(NEW_TOKEN);
    expect(signal?.symbol).toBe("NEW");
    expect(signal?.pairAddress).toBe("0xpool1");
    expect(signal?.priceUsd).toBeCloseTo(0.000007672555179704672, 12);
    expect(signal?.dex).toBe("Uniswap V4");
    expect(signal?.quoteSymbol).toBe("USDC");
    expect(signal?.liquidityUsd).toBe(27376.16);
    expect(signal?.source).toBe("dexpaprika-pools");
  });

  test("carries the pool 1h momentum gain onto the signal", async () => {
    const { client } = stubClient([], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    const signal = await service.normalizePool({
      ...arcPool,
      price_change_percentage_1h: 139.23,
    } as never);
    expect(signal?.momentumGainPct1h).toBeCloseTo(139.23, 9);
  });

  test("dust pools skip details calls below the floor", async () => {
    const dustPool = { ...arcPool, id: "0xdust", liquidity_usd: 50 };
    const { client, calls } = stubClient([dustPool], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", { minPoolLiquidityUsd: 100 }, client);
    expect(await service.getNewPoolSignals(5)).toEqual([]);
    expect(calls()).toBe(0);
  });

  test("pools at the floor still resolve", async () => {
    const { client, calls } = stubClient([arcPool], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", { minPoolLiquidityUsd: 100 }, client);
    expect((await service.getNewPoolSignals(5)).length).toBe(1);
    expect(calls()).toBe(1);
  });

  test("filterIndexed returns only batch-known addresses", async () => {
    const { client, multiCalls } = stubClient([], {}, { [NEW_TOKEN.toLowerCase()]: true });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    const known = await service.filterIndexed([NEW_TOKEN, "0xunknown"]);
    expect([...known]).toEqual([NEW_TOKEN.toLowerCase()]);
    expect(multiCalls()).toBe(1);
  });

  test("filterIndexed fails open to all addresses", async () => {
    const { client } = stubClient([], {}, new Error("rate limited"));
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    const known = await service.filterIndexed([NEW_TOKEN, "0xunknown"]);
    expect([...known].sort()).toEqual([NEW_TOKEN.toLowerCase(), "0xunknown"].sort());
  });

  test("falls back to token details when pool price is zero", async () => {
    const { client } = stubClient([], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("robinhood", WETH, "WETH", {}, client);
    const signal = await service.normalizePool({
      ...arcPool,
      id: "0xpool2",
      price_usd: 0,
      tokens: [{ id: WETH }, { id: NEW_TOKEN }],
    } as never);
    expect(signal?.priceUsd).toBe(0.000007);
    expect(signal?.quoteSymbol).toBe("WETH");
  });

  test("skips ambiguous pools without exactly one candidate leg", async () => {
    const { client } = stubClient([], {});
    const service = new DexPaprikaPoolService("robinhood", WETH, "WETH", {}, client);
    // Both legs non-base: ambiguous.
    expect(
      await service.normalizePool({
        ...arcPool,
        tokens: [{ id: NEW_TOKEN }, { id: "0xother" }],
      } as never),
    ).toBeNull();
    // Only the base leg: nothing to trade.
    expect(
      await service.normalizePool({ ...arcPool, tokens: [{ id: WETH }] } as never),
    ).toBeNull();
  });

  test("caches token details across polls", async () => {
    const stub = stubClient([arcPool], { [NEW_TOKEN.toLowerCase()]: tokenDetails });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, stub.client);
    await service.getNewPoolSignals(5);
    await service.getNewPoolSignals(5);
    expect(stub.calls()).toBe(1);
  });

  test("skips pools whose token has no metadata", async () => {
    const { client } = stubClient([arcPool], {});
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    expect(await service.getNewPoolSignals(5)).toEqual([]);
  });

  test("getTokenSnapshot maps summary fields", async () => {
    const { client } = stubClient([], {
      [NEW_TOKEN.toLowerCase()]: {
        symbol: "NEW",
        decimals: 18,
        market_cap: 1000000,
        summary: {
          liquidity_usd: 50000,
          fdv: 2000000,
          "24h": { volume_usd: 20000, txns: 100 },
        },
      },
    });
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    expect(await service.getTokenSnapshot(NEW_TOKEN)).toEqual({
      liquidityUsd: 50000,
      volumeUsd24h: 20000,
      txns24h: 100,
      mktCapUsd: 1000000,
      fdvUsd: 2000000,
    });
  });

  test("getTokenSnapshot returns nulls when the token is unknown", async () => {
    const { client } = stubClient([], {});
    const service = new DexPaprikaPoolService("arc", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "USDC", {}, client);
    expect(await service.getTokenSnapshot("0xunknown")).toEqual({
      liquidityUsd: null,
      volumeUsd24h: null,
      txns24h: null,
      mktCapUsd: null,
      fdvUsd: null,
    });
  });
});
