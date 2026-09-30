export type TokenPrice = {
  tokenAddress: string;
  pairAddress: string;
  dexId: string;
  symbol: string;
  quoteSymbol: string;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
};

type DexScreenerPair = {
  pairAddress: string;
  dexId: string;
  baseToken: {
    address: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: {
    usd?: number | null;
  } | null;
};

function parseOptionalNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Deterministic one-price-per-token selection.
 *
 * DexScreener returns every pair holding a token, but the engine must evaluate
 * exits against a single venue per poll. Preference order: the position's
 * signal pair when it still reports a price, otherwise the highest-liquidity
 * priced pair, otherwise the first priced pair, otherwise the first pair as-is
 * (the engine ignores null prices downstream).
 */
export function selectTokenPrice(
  pairs: TokenPrice[],
  preferredPairAddress?: string,
): TokenPrice | null {
  if (pairs.length === 0) return null;
  const preferred = preferredPairAddress?.toLowerCase();
  const priced = pairs.filter(
    (pair) => pair.priceUsd !== null && pair.priceUsd > 0,
  );
  if (preferred) {
    const match = priced.find(
      (pair) => pair.pairAddress.toLowerCase() === preferred,
    );
    if (match) return match;
  }
  let best: TokenPrice | null = null;
  for (const pair of priced) {
    const liquidity = pair.liquidityUsd ?? -1;
    const bestLiquidity = best?.liquidityUsd ?? -1;
    if (!best || liquidity > bestLiquidity) best = pair;
  }
  return best ?? priced[0] ?? pairs[0] ?? null;
}

async function fetchBatch(
  baseUrl: string,
  chain: string,
  addresses: string[],
  timeoutMs: number,
): Promise<TokenPrice[]> {
  const url = `${baseUrl}/tokens/v1/${encodeURIComponent(chain)}/${addresses.join(",")}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`DexScreener ${response.status}: ${response.statusText}`);
  }

  const pairs = (await response.json()) as DexScreenerPair[];

  return pairs.map((pair) => ({
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    symbol: pair.baseToken.symbol,
    quoteSymbol: pair.quoteToken.symbol,
    priceUsd: parseOptionalNumber(pair.priceUsd),
    priceNative: parseOptionalNumber(pair.priceNative),
    liquidityUsd: parseOptionalNumber(pair.liquidity?.usd),
  }));
}

/**
 * Fetch current token prices for a chain, one deterministic price per token.
 *
 * DexScreener allows up to 30 token addresses in one request, so the service
 * batches automatically and remains well below the documented 300 requests/min
 * endpoint limit at the default two-second interval.
 *
 * `preferredPairs` optionally pins tokens to their signal pair (token address
 * → pair address, either case); see selectTokenPrice for the fallback order.
 */
export function groupPricesByToken(
  prices: TokenPrice[],
  preferredPairs?: Map<string, string> | Record<string, string>,
): TokenPrice[] {
  const preferred = (token: string): string | undefined => {
    const key = token.toLowerCase();
    return preferredPairs instanceof Map
      ? preferredPairs.get(key)
      : preferredPairs?.[key] ?? preferredPairs?.[token];
  };
  const byToken = new Map<string, TokenPrice[]>();
  for (const price of prices) {
    const key = price.tokenAddress.toLowerCase();
    const list = byToken.get(key) ?? [];
    list.push(price);
    byToken.set(key, list);
  }
  const selected: TokenPrice[] = [];
  for (const [token, pairs] of byToken) {
    const pick = selectTokenPrice(pairs, preferred(token));
    if (pick) selected.push(pick);
  }
  return selected;
}

export async function getPrices(
  chain: string,
  addresses: string[],
  options: {
    baseUrl?: string;
    timeoutMs?: number;
    maxAddresses?: number;
    preferredPairs?: Map<string, string> | Record<string, string>;
  } = {},
): Promise<TokenPrice[]> {
  if (addresses.length === 0) return [];

  const baseUrl = options.baseUrl ?? "https://api.dexscreener.com";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAddresses = options.maxAddresses ?? 30;
  if (maxAddresses < 1 || maxAddresses > 30) {
    throw new Error("DexScreener maxAddresses must be between 1 and 30");
  }

  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const results: TokenPrice[] = [];

  for (let index = 0; index < unique.length; index += maxAddresses) {
    const batch = unique.slice(index, index + maxAddresses);
    results.push(...(await fetchBatch(baseUrl, chain, batch, timeoutMs)));
  }

  return groupPricesByToken(results, options.preferredPairs);
}

/**
 * Poll DexScreener and invoke the callback for each successful batch.
 *
 * `addresses` can be a fixed array or a function returning a current array,
 * which lets the main loop add tokens when Debot discovers new signals.
 */
export function watchPrices(
  chain: string,
  addresses: string[] | (() => string[]),
  intervalMs = 2_000,
  callbacks: {
    onUpdate: (prices: TokenPrice[]) => void;
    onError?: (error: Error) => void;
    baseUrl?: string;
    timeoutMs?: number;
    maxAddresses?: number;
    preferredPairs?:
      | Map<string, string>
      | Record<string, string>
      | (() => Map<string, string> | Record<string, string>);
  },
): () => void {
  let stopped = false;
  let running = false;

  const update = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;

    try {
      const currentAddresses =
        typeof addresses === "function" ? addresses() : addresses;
      const preferred =
        typeof callbacks.preferredPairs === "function"
          ? callbacks.preferredPairs()
          : callbacks.preferredPairs;
      const prices = await getPrices(chain, currentAddresses, {
        baseUrl: callbacks.baseUrl,
        timeoutMs: callbacks.timeoutMs,
        maxAddresses: callbacks.maxAddresses,
        preferredPairs: preferred,
      });

      if (!stopped) callbacks.onUpdate(prices);
    } catch (error) {
      if (!stopped) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
      }
    } finally {
      running = false;
    }
  };

  void update();
  const timer = setInterval(() => void update(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
