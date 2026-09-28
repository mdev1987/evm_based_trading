import { randomUUID } from "node:crypto";

import type { Signal } from "../engine/types";

export type DebotAIDuration = "1m" | "5m";

export type DebotAIRankData = {
  address: string;
  creator_address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  total_supply: number;
  launchpad: string;
  creation_timestamp: number;
  translations: unknown;
  chain: string;
  pair: string;
  dex: {
    dex_name: string;
    dex_index: number;
  };
  base_token: {
    asset_type: string;
    chain: string;
    symbol: string;
    decimal: number;
    name: string;
    address: string;
    reserve: string;
  };
  market_info: {
    price: number;
    holders: number;
    fdv: number;
    mkt_cap: number;
    percent: number;
    percent_5m: number;
    percent_1h: number;
    percent_24h: number;
    buys: number;
    sells: number;
    swaps: number;
    buy_volume: number;
    sell_volume: number;
    volume: number;
    uniq_wallet_swaps: number;
    uniq_wallet_swaps_1h: number;
    last_update_time: number;
  };
  pair_summary_info: {
    liquidity: number;
  };
  safe_info: Record<string, unknown>;
  social_info: {
    description?: string;
    twitter?: string;
    website?: string;
    telegram?: string;
    [key: string]: unknown;
  };
  tags: string[];
  from_launchpad: boolean;
  smart_wallet_online_count: number;
  smart_wallet_total_count: number;
  max_price_gain: number;
  token_tier: string;
  activity_score: number;
};

type DebotAIResponse<T> = {
  data: T;
};

type DebotPriceStateResponse = {
  code: number;
  data: Record<string, { closeTime: string; close: string }>;
};

/**
 * Fetch Debot's keyless major-asset spot prices (`/api/market/price_state`).
 * Returns a map like `{ ETHUSDT: 2686.44, USDCUSDT: 1 }`. Throws on
 * transport or non-2xx errors; callers fall through to the next source.
 */
export async function getDebotPriceState(
  url = "https://debot.ai/api/market/price_state",
  timeoutMs = 10_000,
): Promise<Record<string, number>> {
  const withId = new URL(url);
  withId.searchParams.set("request_id", randomUUID());
  const response = await fetch(withId.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Debot price_state failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as DebotPriceStateResponse;
  const result: Record<string, number> = {};
  for (const [symbol, quote] of Object.entries(body?.data ?? {})) {
    const price = Number(quote?.close);
    if (Number.isFinite(price) && price > 0) result[symbol.toUpperCase()] = price;
  }
  return result;
}

/** Lightweight Debot AI activity-rank client. The base URL is configurable. */
export class DebotAIService {
  constructor(
    private readonly chain: string,
    private readonly timeoutMs = 10_000,
    private readonly baseUrl = "https://debot.ai/api/community/signal/channel",
  ) {}

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Debot AI request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /** Fetch the activity ranking for the configured chain. */
  async getRank(
    duration: DebotAIDuration = "1m",
    limit = 10,
  ): Promise<DebotAIRankData[]> {
    if (limit < 1) throw new Error("Debot limit must be positive");

    const url = new URL(`${this.baseUrl}/activity/rank`);
    url.searchParams.set("request_id", randomUUID());
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("chain", this.chain);
    url.searchParams.set("duration", duration);

    const response = await this.fetchJson<DebotAIResponse<DebotAIRankData[]>>(
      url.toString(),
    );

    return response.data;
  }
}

export type DebotDashboardRankItem = {
  chain: string;
  contract: string;
  meta: {
    name: string;
    symbol: string;
    decimals: number;
    launchpad: string;
  };
  meme_tag_stats: {
    lastPrice: string | number;
    dexProtocol: string;
  };
};

type DebotDashboardResponse = {
  code: number;
  data: Record<string, DebotDashboardRankItem[]>;
};

function dashboardBucket(data: DebotDashboardResponse["data"], column: string): DebotDashboardRankItem[] {
  if (column === "new" && Array.isArray(data.new_creations)) return data.new_creations;
  const direct = (data as Record<string, unknown>)[column];
  if (Array.isArray(direct)) return direct as DebotDashboardRankItem[];
  return [];
}

/**
 * Convert a dashboard rank item into the engine's normalized signal.
 *
 * Dashboard items carry no pair address — DexScreener backfills the pair,
 * DEX, quote symbol and liquidity on the first price tick after entry.
 */
export function normalizeDashboardRank(item: DebotDashboardRankItem): Signal | null {
  if (!item || typeof item !== "object") return null;
  if (!item.contract || !item.meta?.symbol) return null;
  if (!Number.isInteger(item.meta.decimals) || item.meta.decimals < 0) return null;

  const price = Number(item.meme_tag_stats?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  const dex = item.meme_tag_stats?.dexProtocol || item.meta.launchpad || "unknown";

  return {
    tokenAddress: item.contract,
    symbol: item.meta.symbol,
    name: item.meta.name || item.meta.symbol,
    decimals: item.meta.decimals,
    pairAddress: "",
    priceUsd: price,
    dex,
    quoteSymbol: "",
    liquidityUsd: null,
    source: "debot-dashboard",
  };
}

/**
 * Debot dashboard meme-rank client (POST /api/dashboard/meme/v4/ranks).
 * Used for chains like Arc whose community-rank feed is empty.
 */
export class DebotDashboardService {
  constructor(
    private readonly timeoutMs = 10_000,
    private readonly baseUrl = "https://debot.ai",
  ) {}

  async getRanks(
    columns: string[],
    limit: number,
    memeTypes: string[],
  ): Promise<Signal[]> {
    if (limit < 1) throw new Error("Debot dashboard limit must be positive");
    if (columns.length === 0) throw new Error("Debot dashboard columns must not be empty");
    if (memeTypes.length === 0) throw new Error("Debot dashboard memeTypes must not be empty");

    const signals: Signal[] = [];
    const seen = new Set<string>();
    for (const column of columns) {
      const items = await this.getRankColumn(column, limit, memeTypes);
      for (const item of items) {
        const signal = normalizeDashboardRank(item);
        if (!signal) continue;
        const key = signal.tokenAddress.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push(signal);
      }
    }
    return signals;
  }

  /** Fetch one ranks column bucket (new, completing, completed, ...). */
  private async getRankColumn(
    column: string,
    limit: number,
    memeTypes: string[],
  ): Promise<DebotDashboardRankItem[]> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/api/dashboard/meme/v4/ranks?request_id=${randomUUID()}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        column,
        limit,
        sort_field: "",
        groups: [{ meme_types: memeTypes, filter: {} }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Debot dashboard request failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as DebotDashboardResponse;
    return dashboardBucket(body?.data ?? {}, column);
  }
}
