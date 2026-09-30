/**
 * Query the DuckDB transaction history — the replacement for log-grepping.
 *
 * Usage:
 *   bun run history -- "SELECT * FROM trades ORDER BY opened_at DESC LIMIT 5"
 *   bun run history            # trade summary per chain + source
 *   bun run history -- exits   # recent closes
 *   bun run history -- skips   # recent entry rejections
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, getHistoryFile } from "../services/config";
import { HistoryService } from "../services/history";

const SUMMARY = `
SELECT chain, source,
  COUNT(*) AS trades,
  SUM(CASE WHEN exit_reason IS NOT NULL THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN win THEN 1 ELSE 0 END) AS wins,
  ROUND(100 * SUM(CASE WHEN win THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN exit_reason IS NOT NULL THEN 1 ELSE 0 END), 0), 1) AS win_rate_pct,
  ROUND(SUM(COALESCE(exit_pnl_display, 0)), 4) AS total_pnl,
  ROUND(AVG(entry_liq_usd), 0) AS avg_entry_liq,
  ROUND(AVG(entry_vol24_usd), 0) AS avg_entry_vol24
FROM trades
GROUP BY chain, source
ORDER BY chain, source`;

const RECENT_EXITS = `
SELECT chain, symbol, reason, sell_percent, exit_pnl_display AS pnl, origin
FROM exits ORDER BY rowid DESC LIMIT 15`;

const RECENT_SKIPS = `
SELECT chain, symbol, source, reason FROM skips ORDER BY rowid DESC LIMIT 15`;

function print(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  console.table(rows);
}

async function main(): Promise<void> {
  // The running bot holds DuckDB's single write lock, so queries run against
  // a throwaway file copy (WAL included) — a seconds-stale snapshot, fine
  // for analysis and never blocking the writer.
  const source = getHistoryFile(config);
  const dir = join(tmpdir(), "bot-history-read");
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, "history.duckdb"));
  if (existsSync(`${source}.wal`)) copyFileSync(`${source}.wal`, join(dir, "history.duckdb.wal"));
  const history = await HistoryService.open(join(dir, "history.duckdb"), { readOnly: true });
  const arg = process.argv[2];
  if (!arg) {
    console.log("--- trades by chain/source ---");
    print(await history.queryAll(SUMMARY));
    return;
  }
  if (arg === "exits") {
    print(await history.queryAll(RECENT_EXITS));
    return;
  }
  if (arg === "skips") {
    print(await history.queryAll(RECENT_SKIPS));
    return;
  }
  print(await history.queryAll(arg));
}

if (import.meta.main) {
  await main();
}
