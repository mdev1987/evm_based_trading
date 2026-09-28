import ZeroExProtocol, {
  ZeroExApiError,
  ZeroExFeeLimitExceededError,
  ZeroExInsufficientLiquidityError,
  ZeroExReadOnlyError,
  ZeroExTimeoutError,
  ZeroExTransactionRevertedError,
  ZeroExUnsupportedOperationError,
  ZeroExValidationError,
} from "@0x/wdk-protocol-swidge-0x";

import { config } from "./config";

/** Chain IDs used by the first supported EVM chains. */
export enum CHAIN_ID {
  Ethereum = 1,
  Arc = 5042,
  Robinhood = 4663,
}

export interface ZeroExQuoteParams {
  chainId: number;
  fromToken: string;
  toToken: string;
  fromTokenAmount: bigint;
  recipient?: string;
}

export interface ZeroExQuote {
  fromTokenAmount: bigint;
  toTokenAmount: bigint;
  toTokenAmountMin: bigint;
  fees: Awaited<ReturnType<ZeroExProtocol["quoteSwidge"]>>["fees"];
  priceImpact: number | undefined;
}

export type ZeroExQuoteErrorCode =
  | "NO_LIQUIDITY"
  | "API"
  | "FEE_LIMIT"
  | "VALIDATION"
  | "UNSUPPORTED"
  | "UNKNOWN";

export type ZeroExSwapErrorCode =
  | ZeroExQuoteErrorCode
  | "READ_ONLY"
  | "REVERTED"
  | "TIMEOUT"
  | "UNKNOWN_TRANSACTION";

/** Stable application error for failed quote requests. */
export class ZeroExQuoteError extends Error {
  constructor(
    public readonly code: ZeroExQuoteErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ZeroExQuoteError";
  }
}

/** Stable application error for failed live swaps or status checks. */
export class ZeroExSwapError extends Error {
  constructor(
    public readonly code: ZeroExSwapErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ZeroExSwapError";
  }
}

/** Type accepted by a wallet-bound ZeroExProtocol instance. */
export type ZeroExAccount = NonNullable<ConstructorParameters<typeof ZeroExProtocol>[0]>;

/** Transaction result returned by `swidge()`. */
export type ZeroExSwapResult = Awaited<ReturnType<ZeroExProtocol["swidge"]>>;

/** On-chain status returned by `getSwidgeStatus()`. */
export type ZeroExSwapStatus = Awaited<ReturnType<ZeroExProtocol["getSwidgeStatus"]>>;

/** Build a protocol instance for one chain and one wallet mode. */
function createProtocol(chainId: number, account?: ZeroExAccount): ZeroExProtocol {
  const protocolConfig = {
    chainId,
    apiKey: config.zeroEx.apiKey,
    defaultSlippage: config.zeroEx.defaultSlippage,
    baseUrl: config.zeroEx.baseUrl,
    maxNetworkFeeBps: config.zeroEx.maxNetworkFeeBps,
    maxProtocolFeeBps: config.zeroEx.maxProtocolFeeBps,
    skipApproval: config.zeroEx.skipApproval,
  };
  if (account === undefined) return new ZeroExProtocol(undefined, protocolConfig);
  return new ZeroExProtocol(account, protocolConfig);
}

/** Validate swap arguments before calling the external 0x service. */
function validateParams(params: ZeroExQuoteParams): void {
  if (!Number.isSafeInteger(params.chainId) || params.chainId <= 0) {
    throw new ZeroExQuoteError("VALIDATION", "chainId must be a positive integer");
  }
  if (params.fromTokenAmount <= 0n) {
    throw new ZeroExQuoteError("VALIDATION", "fromTokenAmount must be greater than zero");
  }
  if (!params.fromToken.trim()) {
    throw new ZeroExQuoteError("VALIDATION", "fromToken is required");
  }
  if (!params.toToken.trim()) {
    throw new ZeroExQuoteError("VALIDATION", "toToken is required");
  }
  if (params.fromToken.trim().toLowerCase() === params.toToken.trim().toLowerCase()) {
    throw new ZeroExQuoteError("VALIDATION", "fromToken and toToken must be different");
  }
}

/** Convert known WDK errors into the application's quote error type. */
function mapQuoteError(error: unknown): ZeroExQuoteError {
  if (error instanceof ZeroExInsufficientLiquidityError) {
    return new ZeroExQuoteError("NO_LIQUIDITY", error.message, error);
  }
  if (error instanceof ZeroExApiError) {
    return new ZeroExQuoteError("API", error.message, error);
  }
  if (error instanceof ZeroExFeeLimitExceededError) {
    return new ZeroExQuoteError("FEE_LIMIT", error.message, error);
  }
  if (error instanceof ZeroExValidationError) {
    return new ZeroExQuoteError("VALIDATION", error.message, error);
  }
  if (error instanceof ZeroExUnsupportedOperationError) {
    return new ZeroExQuoteError("UNSUPPORTED", error.message, error);
  }
  return new ZeroExQuoteError(
    "UNKNOWN",
    error instanceof Error ? error.message : String(error),
    error,
  );
}

/** Convert known WDK errors into the application's live-swap error type. */
function mapSwapError(error: unknown): ZeroExSwapError {
  if (error instanceof ZeroExReadOnlyError) {
    return new ZeroExSwapError("READ_ONLY", error.message, error);
  }
  if (error instanceof ZeroExTransactionRevertedError) {
    return new ZeroExSwapError("REVERTED", error.message, error);
  }
  if (error instanceof ZeroExTimeoutError) {
    return new ZeroExSwapError("TIMEOUT", error.message, error);
  }
  // ZeroExUnknownTransactionError exists in the WDK runtime (src/errors.js)
  // but is not re-exported from the package index, so match by name.
  if (error instanceof Error && error.name === "ZeroExUnknownTransactionError") {
    return new ZeroExSwapError("UNKNOWN_TRANSACTION", error.message, error);
  }
  if (error instanceof ZeroExInsufficientLiquidityError) {
    return new ZeroExSwapError("NO_LIQUIDITY", error.message, error);
  }
  if (error instanceof ZeroExApiError) {
    return new ZeroExSwapError("API", error.message, error);
  }
  if (error instanceof ZeroExFeeLimitExceededError) {
    return new ZeroExSwapError("FEE_LIMIT", error.message, error);
  }
  if (error instanceof ZeroExValidationError) {
    return new ZeroExSwapError("VALIDATION", error.message, error);
  }
  if (error instanceof ZeroExUnsupportedOperationError) {
    return new ZeroExSwapError("UNSUPPORTED", error.message, error);
  }
  return new ZeroExSwapError(
    "UNKNOWN",
    error instanceof Error ? error.message : String(error),
    error,
  );
}

/**
 * Fetch an indicative `/price` quote without requiring or touching a wallet.
 * This is the quote path used by paper trading and live preflight checks.
 */
export async function getZeroExQuote(params: ZeroExQuoteParams): Promise<ZeroExQuote> {
  validateParams(params);

  try {
    const quote = await createProtocol(params.chainId).quoteSwidge({
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromTokenAmount: params.fromTokenAmount,
      recipient: params.recipient,
    });

    return {
      fromTokenAmount: quote.fromTokenAmount,
      toTokenAmount: quote.toTokenAmount,
      toTokenAmountMin: quote.toTokenAmountMin,
      fees: quote.fees,
      priceImpact: quote.priceImpact,
    };
  } catch (error) {
    throw mapQuoteError(error);
  }
}

/** Create a wallet-bound 0x protocol for a real live swap. */
export function createZeroExExecutionProtocol(
  chainId: number,
  account: ZeroExAccount,
): ZeroExProtocol {
  return createProtocol(chainId, account);
}

/**
 * Submit a real same-chain swap.
 *
 * ERC-20 approval is delegated to the WDK 0x module. This application never
 * creates an approval for the 0x Settler contract.
 */
export async function executeZeroExSwap(
  account: ZeroExAccount,
  params: ZeroExQuoteParams,
): Promise<ZeroExSwapResult> {
  return submitZeroExSwap(account, params);
}

/** Submit a real same-chain swap and return immediately after transaction submission. */
export async function submitZeroExSwap(
  account: ZeroExAccount,
  params: ZeroExQuoteParams,
): Promise<ZeroExSwapResult> {
  validateParams(params);

  try {
    const protocol = createZeroExExecutionProtocol(params.chainId, account);
    return await protocol.swidge({
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromTokenAmount: params.fromTokenAmount,
      recipient: params.recipient,
    });
  } catch (error) {
    throw mapSwapError(error);
  }
}

/** Return the current on-chain status of a previously submitted swap. */
export async function getZeroExSwapStatus(
  account: ZeroExAccount,
  chainId: number,
  swapId: ZeroExSwapResult["id"],
): Promise<ZeroExSwapStatus> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ZeroExSwapError("VALIDATION", "chainId must be a positive integer");
  }

  try {
    const protocol = createZeroExExecutionProtocol(chainId, account);
    return await protocol.getSwidgeStatus(swapId);
  } catch (error) {
    throw mapSwapError(error);
  }
}

/**
 * Poll a submitted swap until a terminal on-chain state or an application
 * timeout is reached.
 */
export async function waitForZeroExSwap(
  protocol: ZeroExProtocol,
  swapId: ZeroExSwapResult["id"],
  pollIntervalMs = config.execution.pollIntervalMs,
  timeoutMs = config.execution.timeoutMs,
): Promise<ZeroExSwapStatus> {
  if (pollIntervalMs < 1) {
    throw new ZeroExSwapError("VALIDATION", "pollIntervalMs must be positive");
  }
  if (timeoutMs < pollIntervalMs) {
    throw new ZeroExSwapError(
      "VALIDATION",
      "timeoutMs must be greater than or equal to pollIntervalMs",
    );
  }

  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new ZeroExSwapError(
        "TIMEOUT",
        `Timed out waiting for 0x swap ${String(swapId)}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const status = await protocol.getSwidgeStatus(swapId);
      if (status.status !== "pending") return status;
    } catch (error) {
      throw mapSwapError(error);
    }
  }
}

/** Submit a live swap and optionally wait for its terminal state. */
export async function executeAndWaitZeroExSwap(
  account: ZeroExAccount,
  params: ZeroExQuoteParams,
  options: {
    wait?: boolean;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<{ result: ZeroExSwapResult; status?: ZeroExSwapStatus }> {
  validateParams(params);

  try {
    const result = await submitZeroExSwap(account, params);

    if (options.wait === false) return { result };

    const protocol = createZeroExExecutionProtocol(params.chainId, account);
    const status = await waitForZeroExSwap(
      protocol,
      result.id,
      options.pollIntervalMs ?? config.execution.pollIntervalMs,
      options.timeoutMs ?? config.execution.timeoutMs,
    );

    return { result, status };
  } catch (error) {
    if (error instanceof ZeroExSwapError) throw error;
    throw mapSwapError(error);
  }
}
