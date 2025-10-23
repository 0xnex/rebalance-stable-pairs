/**
 * Simple fee collection types
 */

export interface FeeCollectionConfig {
  feeCollectionIntervalMs: number;
  minimalTokenAAmount: bigint;
  minimalTokenBAmount: bigint;
}

export interface PositionManager {
  // Core position operations
  getPosition(positionId: string): any;
  collectFees(positionId: string): { fee0: bigint; fee1: bigint } | null;
  addToPosition(positionId: string, amount0: bigint, amount1: bigint): boolean;
  getTotals(): {
    amountA: bigint;
    amountB: bigint;
    feesOwed0: bigint;
    feesOwed1: bigint;
    collectedFees0: bigint;
    collectedFees1: bigint;
  };

  // Position enumeration
  getAllPositions(): any[];
  getActivePositions(): any[];
}

export interface PriceProvider {
  getCurrentPrice(): number;
  getCurrentTick(): number;
}

export type FeeCollectionAction =
  | { action: "none"; message: string }
  | {
      action: "collect_fees";
      message: string;
      feesCollected: { fee0: bigint; fee1: bigint };
      positionsAffected: string[];
    }
  | {
      action: "collect_and_reinvest";
      message: string;
      feesCollected: { fee0: bigint; fee1: bigint };
      positionsAffected: string[];
    };
