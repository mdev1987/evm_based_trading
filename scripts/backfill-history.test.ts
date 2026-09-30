import { describe, expect, test } from "bun:test";

import { parseBackfillLines, parseCompactUsd } from "./backfill-history";

describe("parseCompactUsd", () => {
  test("parses compact dollar amounts", () => {
    expect(parseCompactUsd("$5.06M")).toBeCloseTo(5060000, 0);
    expect(parseCompactUsd("$4.56K")).toBeCloseTo(4560, 1);
    expect(parseCompactUsd("$12.34")).toBeCloseTo(12.34, 2);
    expect(parseCompactUsd("n/a")).toBeNull();
    expect(parseCompactUsd("garbage")).toBeNull();
  });
});

describe("parseBackfillLines", () => {
  test("matches new-format buys to opens and closes", () => {
    const { entries, exits, skips } = parseBackfillLines([
      "[ENGINE][Arc] BUY MURMUR 0xd2d0e63e1da4a24081629aa9c1f61a7fe480b5be (via debot-dashboard) | liq $104.00K | vol24 $896.79K | txns 20 | mcap n/a",
      "[ENGINE][Arc] Opened MURMUR | PAPER | cost 10 USDC",
      "[ENGINE][Arc] CLOSED MURMUR | position PnL 291.70 USDC",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tokenAddress).toBe("0xd2d0e63e1da4a24081629aa9c1f61a7fe480b5be");
    expect(entries[0]?.liqUsd).toBeCloseTo(104000, 0);
    expect(entries[0]?.vol24Usd).toBeCloseTo(896790, 0);
    expect(entries[0]?.txns24).toBe(20);
    expect(entries[0]?.costDisplay).toBe(10);
    expect(exits).toEqual([
      { chain: "Arc", symbol: "MURMUR", timeClosed: false, pnlDisplay: 291.7, baseSymbol: "USDC" },
    ]);
    expect(skips).toHaveLength(0);
  });

  test("handles old-format buys, time closes and quote skips", () => {
    const { entries, exits, skips } = parseBackfillLines([
      "[ENGINE][Robinhood Chain] BUY SHH (via debot-community)",
      "[ENGINE][Robinhood Chain] Opened SHH | PAPER | cost 0.0037 WETH",
      "[ENGINE][Robinhood Chain] TIME-CLOSED SHH | position PnL -0.000419 WETH",
      "[ENGINE][Arc] SKIP BUY RATEXA: NO_LIQUIDITY — No liquidity for swap: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE → 0xadb39208c1c531977db03f1a2cdab45e431500e3 on chain 5042.",
      "[ENGINE][Arc] SKIP JEREMY: max open/pending positions",
      "[ENGINE][Arc] SKIP RUG: low liq $1.00K < $20.00K",
    ]);
    expect(entries[0]?.tokenAddress).toBe("");
    expect(entries[0]?.source).toBe("debot-community");
    expect(exits[0]?.timeClosed).toBe(true);
    expect(exits[0]?.pnlDisplay).toBeCloseTo(-0.000419, 6);
    expect(skips.map((s) => s.reason)).toEqual([
      "quote:NO_LIQUIDITY",
      "low liq $1.00K < $20.00K",
    ]);
    expect(skips[0]?.tokenAddress).toBe("0xadb39208c1c531977db03f1a2cdab45e431500e3");
  });
});
