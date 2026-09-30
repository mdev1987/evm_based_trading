/**
 * One-shot backfill of the DuckDB history from the oxmgr text log.
 *
 * The log carries no timestamps, so ordering is file order only: backfilled
 * rows use negative synthetic `opened_at` keys and `at = 0`, all tagged
 * origin = 'log-backfill'. Re-running clears previous backfill rows first.
 *
 * Deliberately skipped: TP partial lines (amounts unrecoverable) and
 * "max open/pending positions" skips (high-volume noise).
 *
 * Usage: bun run backfill-history -- /path/to/evm-trading-bot.log
 */
import { readFileSync } from "node:fs";

import { config, getHistoryFile } from "../services/config";
import { HistoryService } from "../services/history";

export type BackfillEntry = {
  chain: string;
  mode: string;
  symbol: string;
  tokenAddress: string;
  source: string;
  costDisplay: number;
  baseSymbol: string;
  liqUsd: number | null;
  vol24Usd: number | null;
  txns24: number | null;
  mcapUsd: number | null;
};

export type BackfillExit = {
  chain: string;
  symbol: string;
  timeClosed: boolean;
  pnlDisplay: number;
  baseSymbol: string;
};

export type BackfillSkip = {
  chain: string;
  symbol: string;
  tokenAddress: string;
  source: string;
  reason: string;
};

export type BackfillResult = {
  entries: BackfillEntry[];
  exits: BackfillExit[];
  skips: BackfillSkip[];
};

/** "$5.06M" / "$4.56K" / "$12.34" / "n/a" -> number|null. */
export function parseCompactUsd(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === "n/a" || text === "") return null;
  const match = /^\$?([\d,.]+)([kmb])?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]?.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2] === "b" ? 1e9 : match[2] === "m" ? 1e6 : match[2] === "k" ? 1e3 : 1;
  return amount * multiplier;
}

const BUY_RE =
  /\[ENGINE\]\[(Arc|Robinhood Chain)\] BUY (.+?) (0x[0-9a-fA-F]{40} )?\(via ([^)]+)\)(?: \| liq (\S+) \| vol24 (\S+) \| txns (\S+) \| mcap (\S+))?/;
const OPENED_RE =
  /\[ENGINE\]\[(Arc|Robinhood Chain)\] Opened (.+?) \| (PAPER|LIVE) \| (?:cost ([\d.]+) (\S+)|tx (\S+))/;
const CLOSED_RE =
  /\[ENGINE\]\[(Arc|Robinhood Chain)\] (?:TIME-)?CLOSED (.+?) \| position PnL (-?[\d.]+) (\S+)/;
const TIME_RE = /TIME-CLOSED/;
const SKIP_RE = /\[ENGINE\]\[(Arc|Robinhood Chain)\] SKIP (.+?): (.+)/;
const SKIP_BUY_RE =
  /\[ENGINE\]\[(Arc|Robinhood Chain)\] SKIP BUY (.+?): (\S+) — .*→ (0x[0-9a-fA-F]{40}) on chain \d+\./;

/** Parse raw log lines into backfillable entries, exits and skips. */
export function parseBackfillLines(lines: string[]): BackfillResult {
  const entries: BackfillEntry[] = [];
  const exits: BackfillExit[] = [];
  const skips: BackfillSkip[] = [];
  const pendingBuys = new Map<string, BackfillEntry[]>();

  for (const line of lines) {
    let match = BUY_RE.exec(line);
    if (match) {
      const [, chain, symbol, address, source, liq, vol, txns, mcap] = match;
      const key = `${chain}::${symbol}`;
      const list = pendingBuys.get(key) ?? [];
      list.push({
        chain: chain as string,
        mode: "",
        symbol: symbol as string,
        tokenAddress: (address ?? "").trim(),
        source: source as string,
        costDisplay: 0,
        baseSymbol: "",
        liqUsd: liq ? parseCompactUsd(liq) : null,
        vol24Usd: vol ? parseCompactUsd(vol) : null,
        txns24: txns && txns !== "n/a" ? Number(txns) : null,
        mcapUsd: mcap ? parseCompactUsd(mcap) : null,
      });
      pendingBuys.set(key, list);
      continue;
    }

    match = OPENED_RE.exec(line);
    if (match) {
      const [, chain, symbol, mode, cost, unit] = match;
      const key = `${chain}::${symbol}`;
      const list = pendingBuys.get(key);
      const buy = list?.shift();
      entries.push({
        chain: chain as string,
        mode: mode as string,
        symbol: symbol as string,
        tokenAddress: buy?.tokenAddress ?? "",
        source: buy?.source ?? "unknown",
        costDisplay: cost ? Number(cost) : 0,
        baseSymbol: unit ?? "",
        liqUsd: buy?.liqUsd ?? null,
        vol24Usd: buy?.vol24Usd ?? null,
        txns24: buy?.txns24 ?? null,
        mcapUsd: buy?.mcapUsd ?? null,
      });
      continue;
    }

    match = CLOSED_RE.exec(line);
    if (match) {
      const [, chain, symbol, pnl, unit] = match;
      exits.push({
        chain: chain as string,
        symbol: symbol as string,
        timeClosed: TIME_RE.test(line),
        pnlDisplay: Number(pnl),
        baseSymbol: unit as string,
      });
      continue;
    }

    match = SKIP_BUY_RE.exec(line);
    if (match) {
      const [, chain, symbol, code, token] = match;
      skips.push({
        chain: chain as string,
        symbol: symbol as string,
        tokenAddress: token as string,
        source: "unknown",
        reason: `quote:${code}`,
      });
      continue;
    }

    match = SKIP_RE.exec(line);
    if (match) {
      const [, chain, symbol, reason] = match;
      if ((reason as string).includes("max open/pending positions")) continue;
      skips.push({
        chain: chain as string,
        symbol: symbol as string,
        tokenAddress: "",
        source: "unknown",
        reason: reason as string,
      });
    }
  }

  return { entries, exits, skips };
}

async function main(): Promise<void> {
  const logPath = process.argv[2] ?? `${process.env.HOME}/.local/share/oxmgr/logs/evm-trading-bot.log`;
  const text = readFileSync(logPath, "utf8");
  const { entries, exits, skips } = parseBackfillLines(text.split("\n"));
  console.log(`Parsed ${entries.length} entries, ${exits.length} exits, ${skips.length} skips`);

  const history = await HistoryService.open(getHistoryFile(config));
  await history.clearOrigin("log-backfill");

  // FIFO match exits to entries per (chain, symbol); synthetic negative keys.
  const openQueues = new Map<string, number[]>();
  let seq = 0;
  for (const entry of entries) {
    seq += 1;
    const key = -seq;
    await history.recordEntry({
      chain: entry.chain,
      mode: entry.mode || config.mode,
      tokenAddress: entry.tokenAddress,
      symbol: entry.symbol,
      name: entry.symbol,
      source: entry.source,
      dex: "unknown",
      pairAddress: "",
      openedAt: key,
      entryPriceUsd: 0,
      entryCostRaw: String(entry.costDisplay),
      entryCostDisplay: entry.costDisplay,
      baseSymbol: entry.baseSymbol || (entry.chain === "Arc" ? "USDC" : "WETH"),
      baseDecimals: 18,
      liqUsd: entry.liqUsd,
      vol24Usd: entry.vol24Usd,
      txns24: entry.txns24,
      buys24: null,
      sells24: null,
      mcapUsd: entry.mcapUsd,
      fdvUsd: null,
      holders: null,
      origin: "log-backfill",
    });
    const queueKey = `${entry.chain}::${entry.symbol}`;
    const queue = openQueues.get(queueKey) ?? [];
    queue.push(key);
    openQueues.set(queueKey, queue);
  }

  let matched = 0;
  for (const exit of exits) {
    const queue = openQueues.get(`${exit.chain}::${exit.symbol}`);
    const openedAt = queue?.shift() ?? 0;
    if (openedAt !== 0) matched += 1;
    await history.recordExit({
      chain: exit.chain,
      tokenAddress: "",
      symbol: exit.symbol,
      openedAt,
      reason: exit.timeClosed ? "TIME" : "CLOSE",
      sellPercent: 100,
      exitPriceUsd: null,
      realizedPnlRaw: String(exit.pnlDisplay),
      realizedPnlDisplay: exit.pnlDisplay,
      totalPnlRaw: String(exit.pnlDisplay),
      totalPnlDisplay: exit.pnlDisplay,
      closed: openedAt !== 0,
      eventAt: 0,
      origin: "log-backfill",
    });
  }

  for (const skip of skips) {
    await history.recordSkip({
      ...skip,
      liqUsd: null,
      vol24Usd: null,
      txns24: null,
      eventAt: 0,
      origin: "log-backfill",
    });
  }

  // Event times are unknowable from the log (no timestamps): null them out.
  await history.exec(
    "UPDATE trades SET hold_ms = NULL, closed_at = NULL WHERE origin = 'log-backfill'",
  );
  console.log(`Backfilled ${entries.length} entries, ${matched}/${exits.length} exits matched`);
}

if (import.meta.main) {
  await main();
}
