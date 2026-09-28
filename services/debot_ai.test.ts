import { describe, expect, test } from "bun:test";
import { DebotAIService, DebotDashboardService, getDebotPriceState, normalizeDashboardRank } from "./debot_ai";

describe("DebotAIService.getRank", () => {
  test("sends request_id with chain, limit and duration", async () => {
    const original = globalThis.fetch;
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const service = new DebotAIService("robinhood", 5000, "https://example.invalid");
      await service.getRank("1m", 10);
      const params = new URL(seenUrl).searchParams;
      expect(params.get("chain")).toBe("robinhood");
      expect(params.get("limit")).toBe("10");
      expect(params.get("duration")).toBe("1m");
      expect(params.get("request_id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("getDebotPriceState", () => {  test("parses major-asset closes", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            ETHUSDT: { closeTime: "2026-09-28T22:56:24Z", close: "2686.44" },
            USDCUSDT: { closeTime: "2026-09-28T22:56:24Z", close: "1.0" },
            BOGUS: { closeTime: "2026-09-28T22:56:24Z", close: "oops" },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const prices = await getDebotPriceState("https://example.invalid");
      expect(prices["ETHUSDT"]).toBe(2686.44);
      expect(prices["USDCUSDT"]).toBe(1);
      expect("BOGUS" in prices).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on non-2xx", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("blocked", { status: 403 })) as unknown as typeof fetch;
    try {
      await expect(getDebotPriceState("https://example.invalid")).rejects.toThrow("403");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("normalizeDashboardRank", () => {
  const item = {
    chain: "arc",
    contract: "0x800396035168afb5543c74d5e701e2cafa2ae91e",
    meta: { name: "Cat Processing Unit", symbol: "CPU", decimals: 18, launchpad: "argus" },
    meme_tag_stats: { lastPrice: "0.00001291007942", dexProtocol: "argus" },
  };

  test("normalizes a dashboard item without a pair address", () => {
    const signal = normalizeDashboardRank(item);
    expect(signal).not.toBeNull();
    expect(signal?.tokenAddress).toBe(item.contract);
    expect(signal?.symbol).toBe("CPU");
    expect(signal?.name).toBe("Cat Processing Unit");
    expect(signal?.pairAddress).toBe("");
    expect(signal?.priceUsd).toBeCloseTo(0.00001291007942, 12);
    expect(signal?.dex).toBe("argus");
    expect(signal?.liquidityUsd).toBeNull();
  });

  test("rejects empty symbols and bad prices", () => {
    expect(normalizeDashboardRank({ ...item, meta: { ...item.meta, symbol: "" } })).toBeNull();
    expect(
      normalizeDashboardRank({
        ...item,
        meme_tag_stats: { lastPrice: "0", dexProtocol: "argus" },
      }),
    ).toBeNull();
    expect(
      normalizeDashboardRank({
        ...item,
        meme_tag_stats: { lastPrice: "n/a", dexProtocol: "argus" },
      }),
    ).toBeNull();
  });

  test("falls back to launchpad and symbol for dex/name", () => {
    const signal = normalizeDashboardRank({
      ...item,
      meta: { name: "", symbol: "CPU", decimals: 18, launchpad: "liftfun" },
      meme_tag_stats: { lastPrice: 0.5, dexProtocol: "" },
    });
    expect(signal?.dex).toBe("liftfun");
    expect(signal?.name).toBe("CPU");
  });
});

describe("DebotDashboardService", () => {
  test("posts ranks body and returns normalized signals", async () => {
    const original = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenBody = String((init as { body: string }).body);
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            new_creations: [
              {
                chain: "arc",
                contract: "0xabc",
                meta: { name: "T", symbol: "T", decimals: 18, launchpad: "argus" },
                meme_tag_stats: { lastPrice: "0.01", dexProtocol: "argus" },
              },
              {
                chain: "arc",
                contract: "0xdef",
                meta: { name: "", symbol: "", decimals: 18, launchpad: "argus" },
                meme_tag_stats: { lastPrice: "0.01", dexProtocol: "argus" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const service = new DebotDashboardService(5000, "https://example.invalid");
      const signals = await service.getRanks(["new"], 10, ["arc:argus"]);
      expect(signals.length).toBe(1);
      expect(signals[0]?.tokenAddress).toBe("0xabc");
      expect(seenUrl).toContain("/api/dashboard/meme/v4/ranks?request_id=");
      const body = JSON.parse(seenBody) as { column: string; groups: { meme_types: string[] }[] };
      expect(body.column).toBe("new");
      expect(body.groups[0]?.meme_types).toEqual(["arc:argus"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("merges columns and dedupes contracts", async () => {
    const original = globalThis.fetch;
    const columns: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body: string }).body)) as { column: string };
      columns.push(body.column);
      const items = body.column === "new"
        ? [{ chain: "arc", contract: "0xabc", meta: { name: "T", symbol: "T", decimals: 18, launchpad: "a" }, meme_tag_stats: { lastPrice: "0.01", dexProtocol: "a" } }]
        : [
            { chain: "arc", contract: "0xabc", meta: { name: "T", symbol: "T", decimals: 18, launchpad: "a" }, meme_tag_stats: { lastPrice: "0.02", dexProtocol: "a" } },
            { chain: "arc", contract: "0xghi", meta: { name: "G", symbol: "G", decimals: 18, launchpad: "a" }, meme_tag_stats: { lastPrice: "0.03", dexProtocol: "a" } },
          ];
      return new Response(JSON.stringify({ code: 0, data: { [body.column === "new" ? "new_creations" : body.column]: items } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const service = new DebotDashboardService(5000, "https://example.invalid");
      const signals = await service.getRanks(["new", "completing"], 10, ["arc:argus"]);
      expect(columns).toEqual(["new", "completing"]);
      expect(signals.map((s) => s.tokenAddress)).toEqual(["0xabc", "0xghi"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("rejects empty meme types", async () => {
    const service = new DebotDashboardService();
    await expect(service.getRanks(["new"], 10, [])).rejects.toThrow("memeTypes");
  });
});
