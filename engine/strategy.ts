import type { Position } from "./types";

export type TakeProfit = {
  gainPercent: number;
  sellPercent: number;
};

export type StrategyConfig = {
  takeProfits: TakeProfit[];
  trailingActivationPercent: number;
  trailingDistancePercent: number;
  /** Maximum hold time in ms; 0 disables the time-stop exit. */
  maxHoldMs: number;
  /** Full-exit loss threshold in percent (e.g. 25 = exit at −25%); 0 disables. */
  stopLossPercent: number;
};

export type StrategyAction =
  | { type: "BUY" }
  | { type: "TP"; sellPercent: number }
  | { type: "TRAIL" }
  | { type: "TIME" }
  | { type: "STOP" }
  | { type: "HOLD" };

/** Pure strategy implementation: signal acceptance plus TP/trailing exits. */
export class Strategy {
  constructor(private readonly config: StrategyConfig) {}

  /** Configured take-profit ladder, e.g. [{gainPercent:25,sellPercent:50}]. */
  getTakeProfits(): TakeProfit[] {
    return this.config.takeProfits;
  }

  /** Trailing activation distance, both in percent. */
  getTrailing(): { activationPercent: number; distancePercent: number } {
    return {
      activationPercent: this.config.trailingActivationPercent,
      distancePercent: this.config.trailingDistancePercent,
    };
  }

  /** One-line summary of the TP ladder for trade reports. */
  getTakeProfitSummary(): string {
    return this.config.takeProfits
      .map((tp) => `+${tp.gainPercent}%/${tp.sellPercent}%`)
      .join(", ");
  }

  /** Accept every Debot candidate for the current research phase. */
  evaluateSignal(): StrategyAction {
    return { type: "BUY" };
  }

  /** Evaluate the configured take-profit, trailing-stop and time-stop rules. */
  evaluatePosition(position: Position, now = Date.now()): StrategyAction {
    if (position.entryPriceUsd <= 0 || position.currentPriceUsd <= 0) {
      return { type: "HOLD" };
    }

    const gainPercent =
      ((position.currentPriceUsd - position.entryPriceUsd) /
        position.entryPriceUsd) *
      100;

    const takeProfit = this.config.takeProfits[position.takeProfitIndex];
    if (takeProfit && gainPercent >= takeProfit.gainPercent) {
      return { type: "TP", sellPercent: takeProfit.sellPercent };
    }

    if (
      this.config.stopLossPercent > 0 &&
      gainPercent <= -this.config.stopLossPercent
    ) {
      return { type: "STOP" };
    }

    if (position.trailingActivated && position.highestPriceUsd > 0) {
      const stopPrice =
        position.highestPriceUsd *
        (1 - this.config.trailingDistancePercent / 100);
      if (position.currentPriceUsd <= stopPrice) {
        return { type: "TRAIL" };
      }
    }

    if (this.config.maxHoldMs > 0 && now - position.openedAt >= this.config.maxHoldMs) {
      return { type: "TIME" };
    }

    return { type: "HOLD" };
  }

  /** Determine whether price gain has reached the trailing activation level. */
  shouldActivateTrailing(position: Position): boolean {
    if (position.trailingActivated || position.entryPriceUsd <= 0) return false;

    const gainPercent =
      ((position.currentPriceUsd - position.entryPriceUsd) /
        position.entryPriceUsd) *
      100;

    return gainPercent >= this.config.trailingActivationPercent;
  }
}
