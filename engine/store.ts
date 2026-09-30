import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { JSONFilePreset } from "lowdb/node";

import type { TradingMode } from "../services/config";
import type { EntrySnapshot, WalletState } from "./types";
import { snapshotNumber, snapshotTimestamp } from "./types";

type StateDefaults = {
  file: string;
  mode: TradingMode;
  chain: string;
  initialBaseRaw: bigint;
  initialNativeRaw: bigint;
};

function raw(value: unknown, fallback: bigint, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }

  console.warn(`[STORE] Repairing invalid ${field}; using configured fallback`);
  return fallback.toString();
}

function signedRaw(value: unknown, fallback: bigint, field: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value).toString();
  }

  console.warn(`[STORE] Repairing invalid ${field}; using configured fallback`);
  return fallback.toString();
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Repair an entry snapshot; legacy records without one get empty nulls. */
function normalizeSnapshot(value: unknown): EntrySnapshot {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const created = record.poolCreatedAtMs ?? record.poolCreatedAt;
  return {
    volumeUsd24h: snapshotNumber(record.volumeUsd24h),
    txns24h: snapshotNumber(record.txns24h ?? record.swaps24h),
    buys24h: snapshotNumber(record.buys24h ?? record.buys),
    sells24h: snapshotNumber(record.sells24h ?? record.sells),
    mktCapUsd: snapshotNumber(record.mktCapUsd),
    fdvUsd: snapshotNumber(record.fdvUsd),
    holders: snapshotNumber(record.holders),
    poolCreatedAtMs: snapshotTimestamp(created),
  };
}

function normalizePosition(value: unknown): WalletState["positions"][string] | null {
  if (!value || typeof value !== "object") return null;

  const position = value as Partial<WalletState["positions"][string]>;
  if (!position.tokenAddress || !position.symbol) return null;

  const quantityRaw = raw(position.quantityRaw, 0n, "position.quantityRaw");
  if (quantityRaw === "0") return null;

  const now = Date.now();
  const symbol = String(position.symbol);
  return {
    tokenAddress: String(position.tokenAddress),
    symbol,
    name: typeof position.name === "string" && position.name ? position.name : symbol,
    decimals: Number.isInteger(position.decimals) && Number(position.decimals) >= 0
      ? Number(position.decimals)
      : 18,
    quantityRaw,
    initialQuantityRaw: raw(
      position.initialQuantityRaw,
      BigInt(quantityRaw),
      "position.initialQuantityRaw",
    ),
    costBaseRaw: raw(position.costBaseRaw, 0n, "position.costBaseRaw"),
    realizedPnlBaseRaw: signedRaw(
      position.realizedPnlBaseRaw,
      0n,
      "position.realizedPnlBaseRaw",
    ),
    entryPriceUsd: finiteNumber(position.entryPriceUsd, 0),
    currentPriceUsd: finiteNumber(position.currentPriceUsd, 0),
    highestPriceUsd: finiteNumber(position.highestPriceUsd, 0),
    feesNativeRaw: raw(position.feesNativeRaw, 0n, "position.feesNativeRaw"),
    takeProfitIndex: nonNegativeInteger(position.takeProfitIndex, 0),
    trailingActivated: position.trailingActivated === true,
    openedAt: finiteNumber(position.openedAt, now),
    lastActionAt: finiteNumber(position.lastActionAt, now),
    pairAddress: typeof position.pairAddress === "string" ? position.pairAddress : "",
    dex: typeof position.dex === "string" && position.dex ? position.dex : "unknown",
    quoteSymbol: typeof position.quoteSymbol === "string" ? position.quoteSymbol : "",
    liquidityUsd: typeof position.liquidityUsd === "number" && Number.isFinite(position.liquidityUsd)
      ? position.liquidityUsd
      : null,
    snapshot: normalizeSnapshot(position.snapshot),
    source: typeof position.source === "string" && position.source ? position.source : "unknown",
  };
}

function defaultState(defaults: StateDefaults): WalletState {
  return {
    version: 3,
    mode: defaults.mode,
    chain: defaults.chain,
    balanceBaseRaw: defaults.initialBaseRaw.toString(),
    balanceNativeRaw: defaults.initialNativeRaw.toString(),
    initialBalanceBaseRaw: defaults.initialBaseRaw.toString(),
    initialBalanceNativeRaw: defaults.initialNativeRaw.toString(),
    realizedPnlBaseRaw: "0",
    networkFeesNativeRaw: "0",
    entries: 0,
    wins: 0,
    losses: 0,
    positions: {},
    pendingSwaps: {},
    peakEquityBase: Number(defaults.initialBaseRaw),
    maxDrawdownBase: 0,
    lastWalletSyncAt: 0,
    riskDay: "",
    riskDayStartRealizedPnlRaw: "0",
  };
}

/**
 * Normalize and migrate a state file defensively.
 *
 * State is intentionally limited to wallet/accounting state, not raw market
 * history. Invalid scalar values are repaired rather than crashing the bot.
 */
function migrateState(existing: unknown, defaults: StateDefaults): WalletState {
  const value = existing && typeof existing === "object"
    ? (existing as Partial<WalletState>)
    : {};

  const positions: WalletState["positions"] = {};
  if (value.positions && typeof value.positions === "object") {
    for (const [key, candidate] of Object.entries(value.positions)) {
      const position = normalizePosition(candidate);
      if (position) positions[key.toLowerCase()] = position;
    }
  }

  const initialBaseRaw = raw(
    value.initialBalanceBaseRaw,
    defaults.initialBaseRaw,
    "initialBalanceBaseRaw",
  );
  const initialNativeRaw = raw(
    value.initialBalanceNativeRaw,
    defaults.initialNativeRaw,
    "initialBalanceNativeRaw",
  );

  const balanceBaseRaw = raw(
    value.balanceBaseRaw,
    BigInt(initialBaseRaw),
    "balanceBaseRaw",
  );
  const balanceNativeRaw = raw(
    value.balanceNativeRaw,
    BigInt(initialNativeRaw),
    "balanceNativeRaw",
  );

  const pendingSwaps: WalletState["pendingSwaps"] = {};
  if (value.pendingSwaps && typeof value.pendingSwaps === "object") {
    for (const [id, candidate] of Object.entries(value.pendingSwaps)) {
      if (!candidate || typeof candidate !== "object") continue;
      const pending = candidate as Partial<WalletState["pendingSwaps"][string]>;
      if (!pending.id || (pending.side !== "BUY" && pending.side !== "SELL")) continue;
      if (!pending.tokenAddress || !pending.symbol) continue;

      pendingSwaps[id] = {
        id: String(pending.id),
        // Empty until the wallet submission returns an on-chain hash
        // (PREPARED/UNKNOWN journal stages predate the broadcast result).
        hash: typeof pending.hash === "string" ? pending.hash : "",
        side: pending.side,
        tokenAddress: String(pending.tokenAddress),
        symbol: String(pending.symbol),
        tokenName: typeof pending.tokenName === "string" && pending.tokenName
          ? pending.tokenName
          : String(pending.symbol),
        decimals: Number.isInteger(pending.decimals) && Number(pending.decimals) >= 0
          ? Number(pending.decimals)
          : 18,
        reason: typeof pending.reason === "string" ? pending.reason : "RECOVERY",
        requestedAmountRaw: raw(pending.requestedAmountRaw, 0n, "pending.requestedAmountRaw"),
        signalPriceUsd: finiteNumber(pending.signalPriceUsd, 0),
        beforeBaseRaw: raw(pending.beforeBaseRaw, 0n, "pending.beforeBaseRaw"),
        beforeNativeRaw: raw(pending.beforeNativeRaw, 0n, "pending.beforeNativeRaw"),
        beforeTokenRaw: raw(pending.beforeTokenRaw, 0n, "pending.beforeTokenRaw"),
        estimatedNetworkFeeRaw: raw(
          pending.estimatedNetworkFeeRaw,
          0n,
          "pending.estimatedNetworkFeeRaw",
        ),
        submittedAt: finiteNumber(pending.submittedAt, Date.now()),
        pairAddress: typeof pending.pairAddress === "string" ? pending.pairAddress : "",
        dex: typeof pending.dex === "string" && pending.dex ? pending.dex : "unknown",
        snapshot: normalizeSnapshot(pending.snapshot),
        source: typeof pending.source === "string" && pending.source ? pending.source : "unknown",
        entryLiquidityUsd: typeof pending.entryLiquidityUsd === "number" &&
            Number.isFinite(pending.entryLiquidityUsd)
          ? pending.entryLiquidityUsd
          : null,
        stage: pending.stage === "PREPARED" || pending.stage === "UNKNOWN"
          ? pending.stage
          : "SUBMITTED",
        reviewNotified: pending.reviewNotified === true,
      };
    }
  }

  return {
    version: 3,
    mode: defaults.mode,
    chain: defaults.chain,
    balanceBaseRaw,
    balanceNativeRaw,
    initialBalanceBaseRaw: initialBaseRaw,
    initialBalanceNativeRaw: initialNativeRaw,
    realizedPnlBaseRaw: signedRaw(
      value.realizedPnlBaseRaw,
      0n,
      "realizedPnlBaseRaw",
    ),
    networkFeesNativeRaw: raw(value.networkFeesNativeRaw, 0n, "networkFeesNativeRaw"),
    entries: nonNegativeInteger(value.entries, 0),
    wins: nonNegativeInteger(value.wins, 0),
    losses: nonNegativeInteger(value.losses, 0),
    positions,
    pendingSwaps,
    peakEquityBase: Math.max(
      0,
      finiteNumber(value.peakEquityBase, Number(BigInt(balanceBaseRaw))),
    ),
    maxDrawdownBase: Math.max(0, finiteNumber(value.maxDrawdownBase, 0)),
    lastWalletSyncAt: nonNegativeInteger(value.lastWalletSyncAt, 0),
    riskDay: typeof value.riskDay === "string" ? value.riskDay : "",
    riskDayStartRealizedPnlRaw: signedRaw(
      value.riskDayStartRealizedPnlRaw,
      0n,
      "riskDayStartRealizedPnlRaw",
    ),
  };
}

/** Open a state file and repair legacy/malformed values on first load. */
export async function createStateStore(defaults: StateDefaults) {
  await mkdir(dirname(defaults.file), { recursive: true });

  const db = await JSONFilePreset<WalletState>(defaults.file, defaultState(defaults));
  db.data = migrateState(db.data, defaults);
  await db.write();

  return {
    get data(): WalletState {
      return db.data;
    },
    async save(): Promise<void> {
      await db.write();
    },
    async update(mutate: (state: WalletState) => void): Promise<void> {
      mutate(db.data);
      await db.write();
    },
  };
}

export type StateStore = Awaited<ReturnType<typeof createStateStore>>;
