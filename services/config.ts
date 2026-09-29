/**
 * Central application configuration.
 *
 * Runtime behavior is controlled through environment variables. Bun loads the
 * project's `.env` file automatically; this module only parses and validates
 * those values and exposes a typed configuration object to the rest of the bot.
 */

export type TradingMode = "paper" | "live";
export type SupportedChain = "ARC" | "ROBINHOOD";

export type TakeProfitConfig = {
  gainPercent: number;
  sellPercent: number;
};

export type SignalSource = "community" | "dashboard" | "dexpaprika";

export type ChainConfig = {
  key: SupportedChain;
  name: string;
  chainId: number;
  debotChain: string;
  /** Active signal feeds, in priority order for same-poll duplicates. */
  signalSources: SignalSource[];
  /** Dashboard ranks columns, one POST per column (e.g. new,completing). */
  debotColumns: string[];
  /** Dashboard launchpad meme types (e.g. "arc:argus"); ignored for community. */
  debotMemeTypes: string[];
  dexScreenerChain: string;
  /** DexPaprika network id for base-asset USD pricing ("" = skip). */
  dexpaprikaNetwork: string;
  rpcUrl: string;
  baseToken: string;
  baseSymbol: string;
  baseDecimals: number;
  baseIsNative: boolean;
  nativeSymbol: string;
  nativeDecimals: number;
  nativeToBaseRate: number;
  explorerUrl: string;
  /** Entry filters (USD / counts); 0 disables the corresponding gate. */
  minLiquidityUsd: number;
  minVolumeUsd24h: number;
  minTxns24h: number;
};

export type TelegramConfig = {
  enabled: boolean;
  token: string;
  chatId: string;
  statusEnabled: boolean;
};

export type AppConfig = {
  version: "2.0.0";
  mode: TradingMode;
  chains: ChainConfig[];
  mnemonic: string;
  walletAccountIndex: number;
  liveConfirmation: string;
  stateDir: string;
  paper: {
    initialBase: string;
    initialNative: string;
    /** USD-denominated paper sizing; null = use legacy raw base-unit amounts. */
    initialUsd: string | null;
    buyAmountUsd: string | null;
  };
  risk: {
    buyAmountBase: string;
    maxOpenPositions: number;
    signalReentryCooldownMs: number;
  };
  strategy: {
    takeProfits: TakeProfitConfig[];
    trailingActivationPercent: number;
    trailingDistancePercent: number;
    maxHoldMs: number;
  };
  debot: {
    baseUrl: string;
    duration: "1m" | "5m";
    limit: number;
    pollIntervalMs: number;
    timeoutMs: number;
    priceStateUrl: string;
    dashboardBaseUrl: string;
  };
  dexscreener: {
    baseUrl: string;
    intervalMs: number;
    timeoutMs: number;
    maxAddresses: number;
    trackedTokenTtlMs: number;
  };
  dexpaprika: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    poolLimit: number;
  };
  zeroEx: {
    apiKey: string;
    baseUrl: string;
    defaultSlippage: number;
    maxNetworkFeeBps: number;
    maxProtocolFeeBps: number;
    skipApproval: boolean;
  };
  execution: {
    pollIntervalMs: number;
    timeoutMs: number;
  };
  statusIntervalMs: number;
  logPrices: boolean;
  telegram: TelegramConfig;
};

export const NATIVE_TOKEN_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const CHAIN_DEFAULTS: Record<SupportedChain, ChainConfig> = {
  ARC: {
    key: "ARC",
    name: "Arc",
    chainId: 5042,
    debotChain: "arc",
    signalSources: ["dashboard"],
    debotColumns: ["new", "completing", "completed"],
    debotMemeTypes: [
      "arc:dyorfun",
      "arc:dyorfun_v3",
      "arc:onmifun",
      "arc:argus",
      "arc:o1",
      "arc:circlewarp",
      "arc:actfun",
      "arc:ubifun",
      "arc:klik",
      "arc:trench",
      "arc:radardex",
      "arc:archemist",
      "arc:minara",
      "arc:akafun",
      "arc:pegdfun",
      "arc:tolly",
      "arc:peach",
      "arc:liftfun",
      "arc:synthra",
    ],
    dexScreenerChain: "arc",
    dexpaprikaNetwork: "arc",
    rpcUrl: "https://rpc.arc-scan.org",
    baseToken: NATIVE_TOKEN_SENTINEL,
    baseSymbol: "USDC",
    baseDecimals: 18,
    baseIsNative: true,
    nativeSymbol: "USDC",
    nativeDecimals: 18,
    nativeToBaseRate: 1,
    explorerUrl: "https://arc-scan.org/tx/",
    minLiquidityUsd: 0,
    minVolumeUsd24h: 0,
    minTxns24h: 0,
  },
  ROBINHOOD: {
    key: "ROBINHOOD",
    name: "Robinhood Chain",
    chainId: 4663,
    debotChain: "robinhood",
    signalSources: ["community", "dashboard"],
    debotColumns: ["new", "completing", "completed"],
    debotMemeTypes: [
      "robinhood:pons",
      "robinhood:pons_v2",
      "robinhood:flap",
      "robinhood:flap_stocks_vault",
      "robinhood:uni_instant",
      "robinhood:uni_crowd",
      "robinhood:o1",
      "robinhood:lunchfun",
      "robinhood:pairfund",
      "robinhood:dyorfun",
      "robinhood:dyorfun_v3",
      "robinhood:virtuals_unicorn",
      "robinhood:noxafun",
      "robinhood:noxafi",
      "robinhood:long",
      "robinhood:letscash",
      "robinhood:clanker",
      "robinhood:bankr",
      "robinhood:varo",
      "robinhood:sushi",
      "robinhood:poolsfun",
      "robinhood:bowfun",
      "robinhood:bags",
      "robinhood:trench",
      "robinhood:apestore",
      "robinhood:circus",
      "robinhood:klik",
      "robinhood:memecoinfun_v4",
      "robinhood:arrow",
    ],
    dexScreenerChain: "robinhood",
    dexpaprikaNetwork: "robinhood",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
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
  },
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

function required(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined || value === "") return fallback;

  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be true/false`);
  }
}

function integer(name: string, fallback: number, minimum = 0): number {
  const value = env(name);
  if (value === undefined || value === "") return fallback;
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be an integer`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function decimal(name: string, fallback: number, minimum = 0): number {
  const value = env(name);
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a number >= ${minimum}`);
  }
  return parsed;
}

function boundedPercent(name: string, fallback: number, maximum = Number.POSITIVE_INFINITY): number {
  const value = decimal(name, fallback, 0);
  if (value > maximum) throw new Error(`${name} must be <= ${maximum}`);
  return value;
}

/** Parse an optional positive USD amount; empty means "not configured". */
function optionalPositiveUsd(name: string): string | null {
  const value = env(name);
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number (USD)`);
  }
  return value;
}

/**
 * Parse a non-negative decimal amount exactly into integer base units.
 * Floating-point arithmetic is intentionally avoided for monetary values.
 */
export function parseUnits(value: string, decimals: number, name = "amount"): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative decimal number`);
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${name} has more than ${decimals} decimal places`);
  }

  const fractionRaw = fraction ? BigInt(fraction.padEnd(decimals, "0")) : 0n;
  return BigInt(whole) * 10n ** BigInt(decimals) + fractionRaw;
}

/** Format an integer amount for logs and notifications without floating drift. */
export function formatUnits(raw: bigint, decimals: number, maxFraction = 8): string {
  if (decimals === 0) return raw.toString();

  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;

  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;

  const fractionText = fraction.toString().padStart(decimals, "0").slice(0, maxFraction);
  const trimmed = fractionText.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${trimmed}`;
}

function parseChains(): SupportedChain[] {
  const raw = env("CHAINS") ?? "ARC,Robinhood";
  const values = raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);

  if (values.length === 0) throw new Error("CHAINS must contain at least one chain");

  const unsupported = values.filter((value) => !(value in CHAIN_DEFAULTS));
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported chain(s): ${unsupported.join(", ")}. Supported: ARC, Robinhood`,
    );
  }

  return [...new Set(values)] as SupportedChain[];
}

function parseTakeProfits(): TakeProfitConfig[] {
  const raw = env("TAKE_PROFIT_LEVELS") ?? "25:50,50:100";
  const result: TakeProfitConfig[] = [];

  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid TAKE_PROFIT_LEVELS entry: ${entry}`);
    }

    const gainPercent = Number(parts[0]);
    const sellPercent = Number(parts[1]);
    if (
      !Number.isFinite(gainPercent) ||
      !Number.isFinite(sellPercent) ||
      gainPercent <= 0 ||
      sellPercent <= 0 ||
      sellPercent > 100
    ) {
      throw new Error(
        `Invalid TAKE_PROFIT_LEVELS entry: ${entry}. Expected gain:sell, e.g. 25:50`,
      );
    }

    result.push({ gainPercent, sellPercent });
  }

  if (result.length === 0) throw new Error("TAKE_PROFIT_LEVELS must not be empty");

  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (!previous || !current || current.gainPercent <= previous.gainPercent) {
      throw new Error("TAKE_PROFIT_LEVELS gain thresholds must strictly increase");
    }
  }

  return result;
}

function buildChainConfig(key: SupportedChain): ChainConfig {
  const defaults = CHAIN_DEFAULTS[key];
  const prefix = key;

  const debotSourceRaw = env(`${prefix}_SIGNAL_SOURCES`) ?? defaults.signalSources.join(",");
  const signalSources = [...new Set(
    debotSourceRaw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  )] as SignalSource[];
  if (signalSources.length === 0) {
    throw new Error(`${prefix}_SIGNAL_SOURCES must contain at least one source`);
  }
  const unsupported = signalSources.filter(
    (source) => source !== "community" && source !== "dashboard" && source !== "dexpaprika",
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${prefix}_SIGNAL_SOURCES has unsupported source(s): ${unsupported.join(", ")}. Supported: community, dashboard, dexpaprika`,
    );
  }

  const debotMemeTypes = (env(`${prefix}_DEBOT_MEME_TYPES`) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const memeTypes = debotMemeTypes.length > 0 ? debotMemeTypes : defaults.debotMemeTypes;
  if (signalSources.includes("dashboard") && memeTypes.length === 0) {
    throw new Error(`${prefix}_DEBOT_MEME_TYPES is required when SIGNAL_SOURCES includes dashboard`);
  }

  const debotColumns = (env(`${prefix}_DEBOT_COLUMNS`) ?? defaults.debotColumns.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (signalSources.includes("dashboard") && debotColumns.length === 0) {
    throw new Error(`${prefix}_DEBOT_COLUMNS must contain at least one column`);
  }

  return {
    ...defaults,
    rpcUrl: env(`${prefix}_RPC_URL`) ?? defaults.rpcUrl,
    debotChain: env(`${prefix}_DEBOT_CHAIN`) ?? defaults.debotChain,
    signalSources,
    debotColumns,
    debotMemeTypes: memeTypes,
    dexScreenerChain: env(`${prefix}_DEXSCREENER_CHAIN`) ?? defaults.dexScreenerChain,
    dexpaprikaNetwork: env(`${prefix}_DEXPAPRIKA_NETWORK`) ?? defaults.dexpaprikaNetwork,
    baseToken: env(`${prefix}_BASE_TOKEN`) ?? defaults.baseToken,
    baseSymbol: env(`${prefix}_BASE_SYMBOL`) ?? defaults.baseSymbol,
    baseDecimals: integer(`${prefix}_BASE_DECIMALS`, defaults.baseDecimals, 0),
    baseIsNative: bool(`${prefix}_BASE_IS_NATIVE`, defaults.baseIsNative),
    nativeSymbol: env(`${prefix}_NATIVE_SYMBOL`) ?? defaults.nativeSymbol,
    nativeDecimals: integer(`${prefix}_NATIVE_DECIMALS`, defaults.nativeDecimals, 0),
    nativeToBaseRate: decimal(
      `${prefix}_NATIVE_TO_BASE_RATE`,
      defaults.nativeToBaseRate,
      0,
    ),
    explorerUrl: env(`${prefix}_EXPLORER_URL`) ?? defaults.explorerUrl,
    minLiquidityUsd: decimal(`${prefix}_MIN_LIQUIDITY_USD`, defaults.minLiquidityUsd, 0),
    minVolumeUsd24h: decimal(`${prefix}_MIN_VOLUME_USD_24H`, defaults.minVolumeUsd24h, 0),
    minTxns24h: integer(`${prefix}_MIN_TXNS_24H`, defaults.minTxns24h, 0),
  };
}

function validateChain(chain: ChainConfig): void {
  if (!chain.rpcUrl) throw new Error(`${chain.key}_RPC_URL cannot be empty`);
  if (!chain.debotChain) throw new Error(`${chain.key}_DEBOT_CHAIN cannot be empty`);
  if (chain.signalSources.includes("dashboard") && chain.debotColumns.length === 0) {
    throw new Error(`${chain.key}_DEBOT_COLUMNS cannot be empty`);
  }
  if (!chain.dexScreenerChain) throw new Error(`${chain.key}_DEXSCREENER_CHAIN cannot be empty`);
  if (!chain.baseToken) throw new Error(`${chain.key}_BASE_TOKEN cannot be empty`);
  if (!chain.baseSymbol) throw new Error(`${chain.key}_BASE_SYMBOL cannot be empty`);
  if (!chain.nativeSymbol) throw new Error(`${chain.key}_NATIVE_SYMBOL cannot be empty`);
  if (chain.baseDecimals < 0 || chain.nativeDecimals < 0) {
    throw new Error(`${chain.key}: token decimals cannot be negative`);
  }
  if (chain.nativeToBaseRate <= 0) {
    throw new Error(`${chain.key}_NATIVE_TO_BASE_RATE must be > 0`);
  }
  if (chain.baseIsNative && chain.baseDecimals !== chain.nativeDecimals) {
    throw new Error(
      `${chain.key}: native base asset requires BASE_DECIMALS == NATIVE_DECIMALS`,
    );
  }
}

/** Return the unique state file for one mode and one chain. */
export function getStateFile(configValue: AppConfig, chain: ChainConfig): string {
  return `${configValue.stateDir}/${configValue.mode}/${chain.key.toLowerCase()}.json`;
}

export const config: AppConfig = (() => {
  const modeRaw = (env("MODE") ?? "paper").toLowerCase();
  if (modeRaw !== "paper" && modeRaw !== "live") {
    throw new Error("MODE must be paper or live");
  }

  const mode = modeRaw as TradingMode;
  const chains = parseChains().map(buildChainConfig);
  chains.forEach(validateChain);

  const paper = {
    initialBase: env("PAPER_INITIAL_BASE") ?? "1",
    initialNative: env("PAPER_INITIAL_NATIVE") ?? "0.01",
    initialUsd: optionalPositiveUsd("PAPER_INITIAL_USD"),
    buyAmountUsd: optionalPositiveUsd("BUY_AMOUNT_USD"),
  };

  // USD-denominated paper sizing is all-or-nothing; when set, both the
  // starting balance and the per-trade size convert at the same USD rate.
  if ((paper.initialUsd === null) !== (paper.buyAmountUsd === null)) {
    throw new Error("PAPER_INITIAL_USD and BUY_AMOUNT_USD must be set together");
  }
  if (
    paper.initialUsd !== null &&
    paper.buyAmountUsd !== null &&
    Number(paper.buyAmountUsd) > Number(paper.initialUsd)
  ) {
    throw new Error("BUY_AMOUNT_USD cannot exceed PAPER_INITIAL_USD");
  }

  for (const chain of chains) {
    parseUnits(paper.initialBase, chain.baseDecimals, "PAPER_INITIAL_BASE");
    if (!chain.baseIsNative) {
      parseUnits(paper.initialNative, chain.nativeDecimals, "PAPER_INITIAL_NATIVE");
    }
  }

  const risk = {
    buyAmountBase: env("BUY_AMOUNT_BASE") ?? "0.1",
    maxOpenPositions: integer("MAX_OPEN_POSITIONS", 3, 1),
    signalReentryCooldownMs: integer("SIGNAL_REENTRY_COOLDOWN_MS", 6 * 60 * 60 * 1000, 0),
  };

  for (const chain of chains) {
    parseUnits(risk.buyAmountBase, chain.baseDecimals, "BUY_AMOUNT_BASE");
  }

  const strategy = {
    takeProfits: parseTakeProfits(),
    trailingActivationPercent: boundedPercent("TRAILING_ACTIVATION_PERCENT", 30),
    trailingDistancePercent: boundedPercent("TRAILING_DISTANCE_PERCENT", 10, 99.999999),
    maxHoldMs: integer("TIME_STOP_MS", 24 * 60 * 60 * 1000, 0),
  };

  const debotDurationRaw = env("DEBOT_DURATION") ?? "1m";
  if (debotDurationRaw !== "1m" && debotDurationRaw !== "5m") {
    throw new Error("DEBOT_DURATION must be 1m or 5m");
  }

  const dexscreenerMaxAddresses = integer("DEXSCREENER_MAX_ADDRESSES", 30, 1);
  if (dexscreenerMaxAddresses > 30) {
    throw new Error("DEXSCREENER_MAX_ADDRESSES cannot exceed 30");
  }

  const zeroExDefaultSlippage = decimal("ZERO_EX_DEFAULT_SLIPPAGE", 0.005, 0);
  if (zeroExDefaultSlippage >= 1) {
    throw new Error("ZERO_EX_DEFAULT_SLIPPAGE must be < 1 (for example 0.005 = 0.5%)");
  }

  const telegramEnabled = bool("TELEGRAM_ENABLED", false);
  const telegramStatusEnabled = bool("TELEGRAM_STATUS_ENABLED", false);
  const telegramToken = env("TELEGRAM_BOT_TOKEN") ?? "";
  const telegramChatId = env("TELEGRAM_CHAT_ID") ?? "";
  if (telegramEnabled && (!telegramToken || !telegramChatId)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true");
  }
  if (telegramStatusEnabled && !telegramEnabled) {
    throw new Error("TELEGRAM_ENABLED=true is required when TELEGRAM_STATUS_ENABLED=true");
  }

  const mnemonic = env("MNEMONIC") ?? "";
  const liveConfirmation = env("LIVE_TRADING_CONFIRM") ?? "";
  if (mode === "live") {
    if (!mnemonic) throw new Error("MNEMONIC is required in MODE=live");
    if (liveConfirmation !== "YES") {
      throw new Error("LIVE_TRADING_CONFIRM=YES is required in MODE=live");
    }
  }

  return {
    version: "2.0.0",
    mode,
    chains,
    mnemonic,
    walletAccountIndex: integer("WALLET_ACCOUNT_INDEX", 0, 0),
    liveConfirmation,
    stateDir: env("STATE_DIR") ?? ".data",
    paper,
    risk,
    strategy,
    debot: {
      baseUrl: env("DEBOT_BASE_URL") ?? "https://debot.ai/api/community/signal/channel",
      duration: debotDurationRaw,
      limit: integer("DEBOT_LIMIT", 10, 1),
      pollIntervalMs: integer("DEBOT_POLL_INTERVAL_MS", 30_000, 1_000),
      timeoutMs: integer("DEBOT_TIMEOUT_MS", 10_000, 1),
      priceStateUrl: env("DEBOT_PRICE_STATE_URL") ?? "https://debot.ai/api/market/price_state",
      dashboardBaseUrl: env("DEBOT_DASHBOARD_BASE_URL") ?? "https://debot.ai",
    },
    dexscreener: {
      baseUrl: env("DEXSCREENER_BASE_URL") ?? "https://api.dexscreener.com",
      intervalMs: integer("DEXSCREENER_INTERVAL_MS", 2_000, 250),
      timeoutMs: integer("DEXSCREENER_TIMEOUT_MS", 10_000, 1),
      maxAddresses: dexscreenerMaxAddresses,
      trackedTokenTtlMs: integer("TRACKED_TOKEN_TTL_MS", 10 * 60 * 1000, 1),
    },
    dexpaprika: {
      baseUrl: env("DEXPAPRIKA_BASE_URL") ?? "https://api.dexpaprika.com",
      apiKey: env("DEXPAPRIKA_API_KEY") ?? "",
      timeoutMs: integer("DEXPAPRIKA_TIMEOUT_MS", 10_000, 1),
      poolLimit: integer("DEXPAPRIKA_POOL_LIMIT", 10, 1),
    },
    zeroEx: {
      apiKey: required("ZERO_EX_API_KEY"),
      baseUrl: env("ZERO_EX_BASE_URL") ?? "https://api.0x.org",
      defaultSlippage: zeroExDefaultSlippage,
      maxNetworkFeeBps: decimal("ZERO_EX_MAX_NETWORK_FEE_BPS", 100, 0),
      maxProtocolFeeBps: decimal("ZERO_EX_MAX_PROTOCOL_FEE_BPS", 100, 0),
      skipApproval: bool("ZERO_EX_SKIP_APPROVAL", false),
    },
    execution: {
      pollIntervalMs: integer("EXECUTION_POLL_INTERVAL_MS", 3_000, 250),
      timeoutMs: integer("EXECUTION_TIMEOUT_MS", 120_000, 1_000),
    },
    statusIntervalMs: integer("STATUS_INTERVAL_MS", 10_000, 1_000),
    logPrices: bool("LOG_PRICES", false),
    telegram: {
      enabled: telegramEnabled,
      token: telegramToken,
      chatId: telegramChatId,
      statusEnabled: telegramStatusEnabled,
    },
  };
})();

