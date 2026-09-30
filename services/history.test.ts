import { describe, expect, test } from "bun:test";

import { HistoryService } from "./history";

describe("HistoryService", () => {
  test("entry then exit round-trips with win flag", async () => {
    const history = await HistoryService.open(":memory:");
    expect(history.enabled).toBe(true);

    await history.recordEntry({
      chain: "Arc",
      mode: "paper",
      tokenAddress: "0xtoken",
      symbol: "TEST",
      name: "Test",
      source: "debot-dashboard",
      dex: "argus",
      pairAddress: "0xpair",
      openedAt: 1000,
      entryPriceUsd: 1,
      entryCostRaw: "10000000000000000000",
      entryCostDisplay: 10,
      baseSymbol: "USDC",
      baseDecimals: 18,
      liqUsd: 50000,
      vol24Usd: 20000,
      txns24: 100,
      buys24: 60,
      sells24: 40,
      mcapUsd: 1000000,
      fdvUsd: 2000000,
      holders: 500,
    });

    await history.recordExit({
      chain: "Arc",
      tokenAddress: "0xtoken",
      symbol: "TEST",
      openedAt: 1000,
      reason: "TP",
      sellPercent: 100,
      exitPriceUsd: 1.5,
      realizedPnlRaw: "5000000000000000000",
      realizedPnlDisplay: 5,
      totalPnlRaw: "5000000000000000000",
      totalPnlDisplay: 5,
      closed: true,
      eventAt: 2000,
    });

    const trades = await history.queryAll(
      "SELECT symbol, win, exit_reason, hold_ms, entry_liq_usd FROM trades",
    );
    expect(trades).toEqual([
      { symbol: "TEST", win: true, exit_reason: "TP", hold_ms: 1000n, entry_liq_usd: 50000 },
    ]);

    const exits = await history.queryAll("SELECT reason, sell_percent FROM exits");
    expect(exits).toEqual([{ reason: "TP", sell_percent: 100 }]);
  });

  test("partial exits accumulate without closing", async () => {
    const history = await HistoryService.open(":memory:");
    await history.recordEntry({
      chain: "Arc",
      mode: "paper",
      tokenAddress: "0xp",
      symbol: "P",
      name: "P",
      source: "debot-dashboard",
      dex: "argus",
      pairAddress: "",
      openedAt: 1000,
      entryPriceUsd: 1,
      entryCostRaw: "10",
      entryCostDisplay: 10,
      baseSymbol: "USDC",
      baseDecimals: 18,
      liqUsd: null,
      vol24Usd: null,
      txns24: null,
      buys24: null,
      sells24: null,
      mcapUsd: null,
      fdvUsd: null,
      holders: null,
    });
    await history.recordExit({
      chain: "Arc",
      tokenAddress: "0xp",
      symbol: "P",
      openedAt: 1000,
      reason: "TP",
      sellPercent: 50,
      exitPriceUsd: 1.25,
      realizedPnlRaw: "2",
      realizedPnlDisplay: 2,
      totalPnlRaw: "2",
      totalPnlDisplay: 2,
      closed: false,
      eventAt: 1500,
    });

    const trades = await history.queryAll("SELECT closed_at, win FROM trades");
    expect(trades).toEqual([{ closed_at: null, win: null }]);
    const exits = await history.queryAll("SELECT COUNT(*) AS n FROM exits");
    expect(exits).toEqual([{ n: 1n }]);
  });

  test("skips record gate rejections", async () => {
    const history = await HistoryService.open(":memory:");
    await history.recordSkip({
      chain: "Arc",
      symbol: "RUG",
      tokenAddress: "0xrug",
      source: "debot-dashboard",
      reason: "low liq $1.00K < $20.00K",
      liqUsd: 1000,
      vol24Usd: null,
      txns24: null,
      eventAt: 3000,
    });
    const rows = await history.queryAll("SELECT symbol, reason FROM skips");
    expect(rows).toEqual([{ symbol: "RUG", reason: "low liq $1.00K < $20.00K" }]);
  });

  test("disabled stub never throws", async () => {
    const history = HistoryService.disabled();
    expect(history.enabled).toBe(false);
    await history.recordEntry({} as never);
    await history.recordExit({} as never);
    await history.recordSkip({} as never);
    await expect(history.queryAll("SELECT 1")).rejects.toThrow("not open");
  });
});
