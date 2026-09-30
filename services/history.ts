/**
 * DuckDB-backed persistent transaction history.
 *
 * The bot's analytical mirror: every entry, partial/full exit and entry
 * rejection is recorded as a structured row so analysis runs in SQL instead
 * of log-grepping. The lowdb state files remain the source of truth for
 * wallet accounting; this database is derived and disposable.
 *
 * All writes are fail-open: a database failure degrades to a single warning
 * and never interrupts the trading loop.
 */

import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

export type TradeEntry = {
  chain: string;
  mode: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  source: string;
  dex: string;
  pairAddress: string;
  openedAt: number;
  entryPriceUsd: number;
  entryCostRaw: string;
  entryCostDisplay: number;
  baseSymbol: string;
  baseDecimals: number;
  liqUsd: number | null;
  vol24Usd: number | null;
  txns24: number | null;
  buys24: number | null;
  sells24: number | null;
  mcapUsd: number | null;
  fdvUsd: number | null;
  holders: number | null;
  origin?: string;
};

export type TradeExit = {
  chain: string;
  tokenAddress: string;
  symbol: string;
  openedAt: number;
  reason: string;
  sellPercent: number;
  exitPriceUsd: number | null;
  realizedPnlRaw: string;
  realizedPnlDisplay: number;
  totalPnlRaw: string;
  totalPnlDisplay: number;
  closed: boolean;
  eventAt: number;
  origin?: string;
};

export type SkipRecord = {
  chain: string;
  symbol: string;
  tokenAddress: string;
  source: string;
  reason: string;
  liqUsd: number | null;
  vol24Usd: number | null;
  txns24: number | null;
  eventAt: number;
  origin?: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  chain VARCHAR NOT NULL,
  mode VARCHAR NOT NULL,
  token_address VARCHAR NOT NULL,
  symbol VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  dex VARCHAR NOT NULL,
  pair_address VARCHAR NOT NULL,
  opened_at BIGINT NOT NULL,
  entry_price_usd DOUBLE NOT NULL,
  entry_cost_raw VARCHAR NOT NULL,
  entry_cost_display DOUBLE NOT NULL,
  base_symbol VARCHAR NOT NULL,
  base_decimals INTEGER NOT NULL,
  entry_liq_usd DOUBLE,
  entry_vol24_usd DOUBLE,
  entry_txns24 INTEGER,
  entry_buys24 INTEGER,
  entry_sells24 INTEGER,
  entry_mcap_usd DOUBLE,
  entry_fdv_usd DOUBLE,
  entry_holders INTEGER,
  exit_reason VARCHAR,
  exit_price_usd DOUBLE,
  exit_pnl_raw VARCHAR,
  exit_pnl_display DOUBLE,
  hold_ms BIGINT,
  closed_at BIGINT,
  win BOOLEAN,
  origin VARCHAR NOT NULL DEFAULT 'live',
  PRIMARY KEY (chain, token_address, opened_at)
);
CREATE TABLE IF NOT EXISTS exits (
  chain VARCHAR NOT NULL,
  token_address VARCHAR NOT NULL,
  symbol VARCHAR NOT NULL,
  opened_at BIGINT NOT NULL,
  reason VARCHAR NOT NULL,
  sell_percent DOUBLE NOT NULL,
  exit_price_usd DOUBLE,
  realized_pnl_raw VARCHAR NOT NULL,
  realized_pnl_display DOUBLE NOT NULL,
  event_at BIGINT NOT NULL,
  origin VARCHAR NOT NULL DEFAULT 'live'
);
CREATE TABLE IF NOT EXISTS skips (
  chain VARCHAR NOT NULL,
  symbol VARCHAR NOT NULL,
  token_address VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  liq_usd DOUBLE,
  vol24_usd DOUBLE,
  txns24 INTEGER,
  event_at BIGINT NOT NULL,
  origin VARCHAR NOT NULL DEFAULT 'live'
);
`;

export class HistoryService {
  private constructor(
    private readonly connection: DuckDBConnection | null,
    private warned = false,
  ) {}

  /** Open (creating if needed) the history database and ensure the schema. */
  static async open(path: string, options: { readOnly?: boolean } = {}): Promise<HistoryService> {
    try {
      const instance = options.readOnly
        ? await DuckDBInstance.create(path, { access_mode: "READ_ONLY" })
        : await DuckDBInstance.create(path);
      const connection = await instance.connect();
      if (!options.readOnly) {
        for (const statement of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
          await connection.run(statement);
        }
      }
      return new HistoryService(connection);
    } catch (error) {
      console.warn(
        `[HISTORY] disabled: cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new HistoryService(null, true);
    }
  }

  /** Fail-open stub used when history is disabled by configuration. */
  static disabled(): HistoryService {
    return new HistoryService(null, true);
  }

  get enabled(): boolean {
    return this.connection !== null;
  }

  private fail(error: unknown, what: string): void {
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `[HISTORY] ${what} failed, history writes degraded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Insert a trade entry; re-inserting the same key refreshes entry columns. */
  async recordEntry(entry: TradeEntry): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.run(
        `INSERT INTO trades (chain, mode, token_address, symbol, name, source, dex,
            pair_address, opened_at, entry_price_usd, entry_cost_raw, entry_cost_display,
            base_symbol, base_decimals, entry_liq_usd, entry_vol24_usd, entry_txns24,
            entry_buys24, entry_sells24, entry_mcap_usd, entry_fdv_usd, entry_holders, origin)
         VALUES ($chain, $mode, $token_address, $symbol, $name, $source, $dex,
            $pair_address, $opened_at::BIGINT, $entry_price_usd::DOUBLE, $entry_cost_raw,
            $entry_cost_display::DOUBLE, $base_symbol, $base_decimals::INTEGER,
            $entry_liq_usd::DOUBLE, $entry_vol24_usd::DOUBLE, $entry_txns24::INTEGER,
            $entry_buys24::INTEGER, $entry_sells24::INTEGER, $entry_mcap_usd::DOUBLE,
            $entry_fdv_usd::DOUBLE, $entry_holders::INTEGER, $origin)
         ON CONFLICT (chain, token_address, opened_at) DO UPDATE SET
           symbol = excluded.symbol, entry_price_usd = excluded.entry_price_usd,
           entry_liq_usd = excluded.entry_liq_usd, entry_vol24_usd = excluded.entry_vol24_usd,
           entry_txns24 = excluded.entry_txns24, entry_mcap_usd = excluded.entry_mcap_usd,
           entry_fdv_usd = excluded.entry_fdv_usd`,
        {
          chain: entry.chain,
          mode: entry.mode,
          token_address: entry.tokenAddress,
          symbol: entry.symbol,
          name: entry.name,
          source: entry.source,
          dex: entry.dex,
          pair_address: entry.pairAddress,
          opened_at: entry.openedAt,
          entry_price_usd: entry.entryPriceUsd,
          entry_cost_raw: entry.entryCostRaw,
          entry_cost_display: entry.entryCostDisplay,
          base_symbol: entry.baseSymbol,
          base_decimals: entry.baseDecimals,
          entry_liq_usd: entry.liqUsd,
          entry_vol24_usd: entry.vol24Usd,
          entry_txns24: entry.txns24,
          entry_buys24: entry.buys24,
          entry_sells24: entry.sells24,
          entry_mcap_usd: entry.mcapUsd,
          entry_fdv_usd: entry.fdvUsd,
          entry_holders: entry.holders,
          origin: entry.origin ?? "live",
        },
      );
    } catch (error) {
      this.fail(error, "recordEntry");
    }
  }

  /** Record one partial or full exit; full exits finalize the trade row. */
  async recordExit(exit: TradeExit): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.run(
        `INSERT INTO exits (chain, token_address, symbol, opened_at, reason, sell_percent,
            exit_price_usd, realized_pnl_raw, realized_pnl_display, event_at, origin)
         VALUES ($chain, $token_address, $symbol, $opened_at::BIGINT, $reason,
            $sell_percent::DOUBLE, $exit_price_usd::DOUBLE, $realized_pnl_raw,
            $realized_pnl_display::DOUBLE, $event_at::BIGINT, $origin)`,
        {
          chain: exit.chain,
          token_address: exit.tokenAddress,
          symbol: exit.symbol,
          opened_at: exit.openedAt,
          reason: exit.reason,
          sell_percent: exit.sellPercent,
          exit_price_usd: exit.exitPriceUsd,
          realized_pnl_raw: exit.realizedPnlRaw,
          realized_pnl_display: exit.realizedPnlDisplay,
          event_at: exit.eventAt,
          origin: exit.origin ?? "live",
        },
      );

      if (exit.closed) {
        await this.connection.run(
          `UPDATE trades SET exit_reason = $reason, exit_price_usd = $exit_price_usd::DOUBLE,
              exit_pnl_raw = $total_pnl_raw, exit_pnl_display = $total_pnl_display::DOUBLE,
              hold_ms = $event_at::BIGINT - opened_at, closed_at = $event_at::BIGINT,
              win = $total_pnl_display::DOUBLE > 0
           WHERE chain = $chain AND token_address = $token_address AND opened_at = $opened_at::BIGINT`,
          {
            reason: exit.reason,
            exit_price_usd: exit.exitPriceUsd,
            total_pnl_raw: exit.totalPnlRaw,
            total_pnl_display: exit.totalPnlDisplay,
            event_at: exit.eventAt,
            chain: exit.chain,
            token_address: exit.tokenAddress,
            opened_at: exit.openedAt,
          },
        );
      }
    } catch (error) {
      this.fail(error, "recordExit");
    }
  }

  /** Record one entry rejection (entry-filter gate or missing 0x route). */
  async recordSkip(skip: SkipRecord): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.run(
        `INSERT INTO skips (chain, symbol, token_address, source, reason,
            liq_usd, vol24_usd, txns24, event_at, origin)
         VALUES ($chain, $symbol, $token_address, $source, $reason,
            $liq_usd::DOUBLE, $vol24_usd::DOUBLE, $txns24::INTEGER, $event_at::BIGINT, $origin)`,
        {
          chain: skip.chain,
          symbol: skip.symbol,
          token_address: skip.tokenAddress,
          source: skip.source,
          reason: skip.reason,
          liq_usd: skip.liqUsd,
          vol24_usd: skip.vol24Usd,
          txns24: skip.txns24,
          event_at: skip.eventAt,
          origin: skip.origin ?? "live",
        },
      );
    } catch (error) {
      this.fail(error, "recordSkip");
    }
  }

  /** Run an analytical query and return plain row objects. */
  async queryAll(sql: string): Promise<Record<string, unknown>[]> {
    if (!this.connection) throw new Error("History database is not open");
    const reader = await this.connection.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  /** Execute a write statement (maintenance/backfill scripts). */
  async exec(
    sql: string,
    params: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    if (!this.connection) throw new Error("History database is not open");
    await this.connection.run(sql, params);
  }

  /** Remove all rows of one origin (makes the log backfill re-runnable). */
  async clearOrigin(origin: string): Promise<void> {
    if (!this.connection) throw new Error("History database is not open");
    for (const table of ["trades", "exits", "skips"]) {
      await this.connection.run(`DELETE FROM ${table} WHERE origin = $origin`, { origin });
    }
  }
}
