import { describe, expect, test } from "bun:test";
import {
  buildBuyMessage,
  buildExitMessage,
  buildPlumbingMessage,
  buildTrailingMessage,
  formatDuration,
  formatGainPct,
  formatLiquidity,
  formatSource,
  formatUsd,
  formatWinRate,
} from "./report";
import type { ChainConfig } from "../services/config";

const chain: ChainConfig = {
  key: "ROBINHOOD",
  name: "Robinhood Chain",
  chainId: 4663,
  debotChain: "robinhood",
  debotColumns: ["new"],
  debotMemeTypes: [],
  signalSources: ["dexpaprika", "community"],
  dexScreenerChain: "robinhood",
  dexpaprikaNetwork: "robinhood",
  rpcUrl: "https://example.invalid",
  baseToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  baseSymbol: "WETH",
  baseDecimals: 18,
  baseIsNative: false,
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  nativeToBaseRate: 1,
  explorerUrl: "https://robinhoodchain.blockscout.com/tx/",
  minLiquidityUsd: 0,
  minVolumeUsd24h: 0,
  minTxns24h: 0,
};

const stats = { wins: 2, losses: 1, entries: 5, openPositions: 2 };
const before = { baseRaw: 700000000000000000n, nativeRaw: 9975989997802000n };
const after = { baseRaw: 600000000000000000n, nativeRaw: 9970000000000000n };

describe("report formatting", () => {
  test("buy message carries identity, balances, win rate and chain", () => {
    const message = buildBuyMessage({
      chain,
      mode: "paper",
      tokenName: "Handsome",
      symbol: "HANDO",
      tokenAddress: "0xe3bf3dd942d5d339abee85c9cd98811dc285f8f6",
      pairAddress: "0xpair000000000000000000000000000000000000001",
      dex: "uniswap",
      quoteSymbol: "WETH",
      liquidityUsd: 1234567,
      entryPriceUsd: 0.00003595657003,
      quantityRaw: 7001367637716526240995691n,
      quantityDecimals: 18,
      costBaseRaw: 100000000000000000n,
      networkFeeRaw: 8488169203500n,
      before,
      after,
      stats,
      tpSummary: "+25%/50%, +50%/100%",
    });

    for (
      const expected of [
        "BUY",
        "HANDO",
        "Handsome",
        "0xe3bf3dd942d5d339abee85c9cd98811dc285f8f6",
        "0xpair000000000000000000000000000000000000001",
        "uniswap",
        "Robinhood",
        "4663",
        "66.67%",
        "2W/1L",
        "→",
        "TP",
        "dexscreener.com",
      ]
    ) {
      expect(message).toContain(expected);
    }
  });

  test("partial exit shows entry/exit, pnl, remaining and duration", () => {
    const message = buildExitMessage({
      chain,
      mode: "paper",
      closed: false,
      reason: "TP",
      tokenName: "Handsome",
      symbol: "HANDO",
      tokenAddress: "0xe3bf3dd942d5d339abee85c9cd98811dc285f8f6",
      pairAddress: "0xpair000000000000000000000000000000000000001",
      dex: "uniswap",
      quoteSymbol: "WETH",
      liquidityUsd: 250000,
      entryPriceUsd: 0.00003595657003,
      exitPriceUsd: 0.000045,
      highestPriceUsd: 0.000046,
      sellPercent: 50,
      proceedsBaseRaw: 60000000000000000n,
      realizedPnlBaseRaw: 10000000000000000n,
      totalPositionPnlBaseRaw: 10000000000000000n,
      remainingQuantityRaw: 3500683818858263120497845n,
      remainingQuantityDecimals: 18,
      remainingCostBaseRaw: 50000000000000000n,
      networkFeeRaw: 8000000000000000n,
      before,
      after,
      openedAt: Date.now() - 3_700_000,
      closedAt: Date.now(),
      stats,
    });

    for (
      const expected of [
        "PARTIAL TP",
        "Entry:",
        "Exit:",
        "PnL",
        "Remaining:",
        "Duration:",
        "Win rate:",
        "HANDO",
      ]
    ) {
      expect(message).toContain(expected);
    }
  });

  test("close shows win/loss outcome and trailing reason", () => {
    const message = buildExitMessage({
      chain,
      mode: "live",
      closed: true,
      reason: "TRAIL",
      tokenName: "Troll",
      symbol: "TROLL",
      tokenAddress: "0x2a13008cc2f5a853f6fb21cbd90841806c64b247",
      pairAddress: "",
      dex: "unknown",
      quoteSymbol: "WETH",
      liquidityUsd: null,
      entryPriceUsd: 0.001,
      exitPriceUsd: 0.0009,
      highestPriceUsd: 0.0014,
      sellPercent: 100,
      proceedsBaseRaw: 90000000000000000n,
      realizedPnlBaseRaw: -10000000000000000n,
      totalPositionPnlBaseRaw: -10000000000000000n,
      remainingQuantityRaw: 0n,
      remainingQuantityDecimals: 18,
      remainingCostBaseRaw: 0n,
      networkFeeRaw: 8000000000000000n,
      before,
      after,
      openedAt: Date.now() - 90_000,
      closedAt: Date.now(),
      stats,
      txHash: "0xabc",
      explorerUrl: chain.explorerUrl,
    });

    expect(message).toContain("TRAIL CLOSE");
    expect(message).toContain("LOSS");
    expect(message).toContain("0xabc");
  });

  test("trailing message shows stop and activation", () => {
    const message = buildTrailingMessage({
      chain,
      mode: "paper",
      tokenName: "Troll",
      symbol: "TROLL",
      tokenAddress: "0x2a13008cc2f5a853f6fb21cbd90841806c64b247",
      pairAddress: "0xpair000000000000000000000000000000000000002",
      dex: "sushiswap",
      quoteSymbol: "WETH",
      liquidityUsd: 50000,
      entryPriceUsd: 0.001,
      currentPriceUsd: 0.00135,
      highestPriceUsd: 0.00135,
      activationPercent: 30,
      distancePercent: 10,
      openedAt: Date.now() - 600_000,
      stats,
    });

    expect(message).toContain("TRAILING ON");
    expect(message).toContain("Stop:");
    expect(message).toContain("30%");
  });

  test("plumbing message shows tx and explorer", () => {
    const message = buildPlumbingMessage({
      chain,
      mode: "live",
      kind: "SELL_SUBMITTED",
      symbol: "TROLL",
      tokenAddress: "0x2a13008cc2f5a853f6fb21cbd90841806c64b247",
      pairAddress: "",
      dex: "unknown",
      reason: "TP",
      amountLabel: "100 TROLL (50% of position)",
      txHash: "0xdeadbeef",
      explorerUrl: chain.explorerUrl,
    });

    expect(message).toContain("SUBMITTED");
    expect(message).toContain("0xdeadbeef");
    expect(message).toContain(chain.explorerUrl);
  });

  test("helpers format edge cases", () => {
    expect(formatUsd(0)).toBe("N/A");
    expect(formatUsd(1500.5)).toContain("$1,500");
    expect(formatGainPct(25.123)).toBe("+25.12%");
    expect(formatLiquidity(1_500_000)).toBe("$1.50M");
    expect(formatLiquidity(null)).toBe("N/A");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3_700_000)).toContain("1h");
    expect(formatWinRate({ wins: 0, losses: 0, entries: 0, openPositions: 0 })).toContain("0.00%");
  });

  test("source labels identify the feed", () => {
    expect(formatSource("dexpaprika-pools")).toBe("DexPaprika pools");
    expect(formatSource("debot-community")).toBe("Debot rank");
    expect(formatSource("debot-dashboard")).toBe("Debot dashboard");
    expect(formatSource("unknown")).toBe("unknown");
    expect(formatSource(undefined)).toBe("unknown");
  });

  test("buy message shows the source line", () => {
    const message = buildBuyMessage({
      chain,
      mode: "paper",
      tokenName: "Handsome",
      symbol: "HANDO",
      tokenAddress: "0xe3bf3dd942d5d339abee85c9cd98811dc285f8f6",
      pairAddress: "0xpair000000000000000000000000000000000000001",
      dex: "uniswap",
      quoteSymbol: "WETH",
      liquidityUsd: 100,
      entryPriceUsd: 0.001,
      quantityRaw: 1000n,
      quantityDecimals: 18,
      costBaseRaw: 10000000000000000n,
      networkFeeRaw: 1000000000000000n,
      before: { baseRaw: 100000000000000000n, nativeRaw: 10000000000000000n },
      after: { baseRaw: 90000000000000000n, nativeRaw: 9000000000000000n },
      stats,
      tpSummary: "+25%/50%",
      source: "dexpaprika-pools",
    });
    expect(message).toContain("📡 Source: DexPaprika pools");
  });
});
