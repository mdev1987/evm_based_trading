import { parseUnits } from "./config";
import { DexPaprikaClient, type SearchPool, type TokenDetails } from "dexpaprika-sdk";

import { snapshotNumber, type Signal } from "../engine/types";

export type DexPaprikaOptions = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
};

type DexPaprikaTokenResponse = {
  summary?: {
    price_usd?: number | null;
  } | null;
};

/**
 * Fetch the current USD price of a token via DexPaprika.
 *
 * `GET {baseUrl}/networks/{network}/tokens/{address}` → `summary.price_usd`.
 * Returns `null` when the price is missing/invalid; throws on transport or
 * non-2xx errors so callers can decide between fallback and failure.
 */
export async function getTokenPriceUsd(
  network: string,
  tokenAddress: string,
  options: DexPaprikaOptions = {},
): Promise<number | null> {
  if (!network || !tokenAddress) return null;

  const baseUrl = (options.baseUrl ?? "https://api.dexpaprika.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = `${baseUrl}/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}`;

  const headers: Record<string, string> = {};
  // Per DexPaprika docs the key is the entire Authorization header value —
  // no scheme prefix. Anything else (e.g. X-API-Key) is ignored and the call
  // silently falls back to keyless quota.
  if (options.apiKey) headers["Authorization"] = options.apiKey;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  });

  if (!response.ok) {
    throw new Error(`DexPaprika ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as DexPaprikaTokenResponse;
  const price = data?.summary?.price_usd;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Convert a USD-denominated amount into raw base units at a given USD rate.
 * Throws when the inputs are invalid or the result rounds to zero.
 */
export function usdToBaseRaw(usd: number, rateUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("USD amount must be a positive number");
  }
  if (!Number.isFinite(rateUsd) || rateUsd <= 0) {
    throw new Error("USD rate must be a positive number");
  }

  const raw = parseUnits((usd / rateUsd).toFixed(decimals), decimals, "USD conversion");
  if (raw <= 0n) throw new Error("USD conversion rounded to zero; amount too small for asset decimals");
  return raw;
}

/** Nil address used by DexPaprika for native-asset pool legs (e.g. Arc USDC). */
const NIL_ADDRESS = "0x0000000000000000000000000000000000000000";

export type PoolServiceOptions = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  limit?: number;
  /** Token-metadata cache TTL; discovery stays live, details are cached. */
  metaCacheTtlMs?: number;
};

type CachedTokenDetails = {
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  mktCapUsd: number | null;
  fdvUsd: number | null;
  expiresAt: number;
};

function detailsPrice(details: TokenDetails): number | null {
  const candidates = [
    details?.summary?.price_usd,
    (details as { price_usd?: unknown })?.price_usd,
    details?.market_data?.price_usd,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * DexPaprika new-pools signal feed.
 *
 * Polls the newest pools per network, resolves the non-base token in each
 * pool to tradeable metadata (cached per process), and emits engine signals.
 * Pool discovery itself is never cached — only token details are, so repeat
 * polls cost one list call plus details for genuinely unseen tokens.
 */
export class DexPaprikaPoolService {
  private readonly client: DexPaprikaClient;
  private readonly metaCache = new Map<string, CachedTokenDetails>();

  constructor(
    private readonly network: string,
    private readonly baseToken: string,
    private readonly baseSymbol: string,
    private readonly options: PoolServiceOptions = {},
    client?: DexPaprikaClient,
  ) {
    this.client = client ?? new DexPaprikaClient(
      options.baseUrl ?? "https://api.dexpaprika.com",
      { timeout: options.timeoutMs ?? 10_000 },
      {
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        // Signal polling must observe live pools; never serve discovery stale.
        cache: { enabled: false },
      },
    );
  }

  /** Fetch the newest pools and normalize tradeable new-token signals. */
  async getNewPoolSignals(limit?: number): Promise<Signal[]> {
    const response = await this.client.pools.listByNetwork(this.network, {
      limit: limit ?? this.options.limit ?? 10,
      orderBy: "created_at",
      sort: "desc",
    });

    const signals: Signal[] = [];
    for (const pool of response?.results ?? []) {
      try {
        const signal = await this.normalizePool(pool);
        if (signal) signals.push(signal);
      } catch (error) {
        console.warn(
          `[DEXPAPRIKA][${this.network}] skip pool ${pool?.id ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (signals.length > 0) {
      console.log(`[DEXPAPRIKA][${this.network}] pools: ${signals.length} new-token signals`);
    }
    return signals;
  }

  /**
   * Normalize one pool into a signal.
   *
   * The candidate is the single non-base, non-native leg. Pools priced by the
   * indexer use the pool price; unpriced pools fall back to token details.
   */
  async normalizePool(pool: SearchPool): Promise<Signal | null> {
    if (!pool?.id || !Array.isArray(pool.tokens)) return null;

    const candidate = this.pickCandidate(pool);
    if (!candidate) return null;

    const details = await this.getDetails(candidate);
    if (!details) return null;

    const poolPrice = typeof pool.price_usd === "number" &&
      Number.isFinite(pool.price_usd) &&
      pool.price_usd > 0
      ? pool.price_usd
      : null;
    const price = poolPrice ?? details.priceUsd;
    if (price === null) return null;

    const liquidity = typeof pool.liquidity_usd === "number" &&
      Number.isFinite(pool.liquidity_usd)
      ? pool.liquidity_usd
      : null;

    const createdMs = Date.parse(pool.created_at);
    return {
      tokenAddress: candidate,
      symbol: details.symbol,
      name: details.name,
      decimals: details.decimals,
      pairAddress: pool.id,
      priceUsd: price,
      dex: pool.dex_name || "unknown",
      quoteSymbol: this.baseSymbol,
      liquidityUsd: liquidity,
      momentumGainPct1h: typeof pool.price_change_percentage_1h === "number" &&
          Number.isFinite(pool.price_change_percentage_1h)
        ? pool.price_change_percentage_1h
        : null,
      snapshot: {
        volumeUsd24h: snapshotNumber(pool.volume_usd_24h),
        txns24h: snapshotNumber(pool.transactions_24h),
        buys24h: null,
        sells24h: null,
        mktCapUsd: details.mktCapUsd,
        fdvUsd: details.fdvUsd,
        holders: null,
        poolCreatedAtMs: Number.isFinite(createdMs) ? createdMs : null,
      },
      source: "dexpaprika-pools",
    };
  }

  /** Return the single tradeable leg, or null when the pool is ambiguous. */
  private pickCandidate(pool: SearchPool): string | null {
    const base = this.baseToken.toLowerCase();
    const seen = new Map<string, string>();
    for (const token of pool.tokens ?? []) {
      const id = token?.id;
      if (!id) continue;
      const key = id.toLowerCase();
      if (key === base || key === NIL_ADDRESS) continue;
      if (!seen.has(key)) seen.set(key, id);
    }
    return seen.size === 1 ? [...seen.values()][0] as string : null;
  }

  /** Token metadata with a TTL cache; null when the token is untradeable. */
  private async getDetails(address: string): Promise<CachedTokenDetails | null> {
    const key = address.toLowerCase();
    const cached = this.metaCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const details: TokenDetails = await this.client.tokens.getDetails(this.network, address);
    if (
      !details?.symbol ||
      !Number.isInteger(details.decimals) ||
      (details.decimals as number) < 0
    ) {
      return null;
    }

    const entry: CachedTokenDetails = {
      symbol: details.symbol,
      name: details.name || details.symbol,
      decimals: details.decimals,
      priceUsd: detailsPrice(details),
      mktCapUsd: snapshotNumber(details.market_cap),
      fdvUsd: snapshotNumber(details.summary?.fdv),
      expiresAt: Date.now() + (this.options.metaCacheTtlMs ?? 3600_000),
    };
    this.metaCache.set(key, entry);
    return entry;
  }

  /**
   * Entry snapshot for an arbitrary token (used to enrich price-only
   * dashboard signals before entry filters run). Returns nulls when the
   * token is unknown; never throws — callers treat nulls as "unverified".
   * Transport errors are logged (not swallowed): if the API itself is down,
   * every signal degrades to unverified and the operator must see why.
   */
  async getTokenSnapshot(address: string): Promise<{
    liquidityUsd: number | null;
    volumeUsd24h: number | null;
    txns24h: number | null;
    mktCapUsd: number | null;
    fdvUsd: number | null;
  }> {
    const nulls = {
      liquidityUsd: null,
      volumeUsd24h: null,
      txns24h: null,
      mktCapUsd: null,
      fdvUsd: null,
    };
    try {
      const raw: TokenDetails = await this.client.tokens.getDetails(this.network, address);
      const summary = raw?.summary;
      return {
        liquidityUsd: snapshotNumber(summary?.liquidity_usd),
        volumeUsd24h: snapshotNumber(summary?.["24h"]?.volume_usd),
        txns24h: snapshotNumber(summary?.["24h"]?.txns),
        mktCapUsd: snapshotNumber(raw?.market_cap),
        fdvUsd: snapshotNumber(summary?.fdv),
      };
    } catch (error) {
      console.warn(
        `[DEXPAPRIKA][${this.network}] snapshot failed for ${address}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return nulls;
    }
  }
}
