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
 * Fetch current token prices for a chain.
 *
 * DexScreener allows up to 30 token addresses in one request, so the service
 * batches automatically and remains well below the documented 300 requests/min
 * endpoint limit at the default two-second interval.
 */
export async function getPrices(
  chain: string,
  addresses: string[],
  options: { baseUrl?: string; timeoutMs?: number; maxAddresses?: number } = {},
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

  return results;
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
      const prices = await getPrices(chain, currentAddresses, {
        baseUrl: callbacks.baseUrl,
        timeoutMs: callbacks.timeoutMs,
        maxAddresses: callbacks.maxAddresses,
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
