/**
 * Shared types and interfaces for enhanced fee collection functionality
 */

export interface FeeCollectionConfig {
  // Core fee collection settings
  enablePeriodicFeeCollection?: boolean;
  feeCollectionIntervalMs?: number;
  feeCollectionThresholdPercent?: number;

  // Smart reinvestment settings
  enableSmartReinvestment?: boolean;
  reinvestmentStrategy?:
    | "most_profitable"
    | "balanced"
    | "active_range"
    | "custom";
  profitabilityWindowMs?: number;
  minReinvestmentAmount?: number;

  // Advanced settings
  maxReinvestmentPerPosition?: number;
  reinvestmentCooldownMs?: number;
  enableRiskManagement?: boolean;
  maxPositionConcentration?: number;

  // Analytics settings
  enableDetailedAnalytics?: boolean;
  analyticsRetentionDays?: number;
  enablePerformanceTracking?: boolean;
}

export interface PositionProfitability {
  positionId: string;
  feeRate0: number; // Fees per hour for token0
  feeRate1: number; // Fees per hour for token1
  totalFeeValue: number; // Combined fee value in token1 equivalent
  profitabilityScore: number; // Overall profitability score (0-1)
  isInRange: boolean; // Currently in price range
  timeInRange: number; // Percentage of time in range
  liquidityUtilization: number; // Liquidity efficiency (0-1)
  riskScore?: number; // Risk assessment score
  momentum?: number; // Profitability trend
}

export interface FeeCollectionEvent {
  timestamp: number;
  totalFees0: bigint;
  totalFees1: bigint;
  positionFees: Map<string, { fee0: bigint; fee1: bigint }>;
  triggerReason: "interval" | "threshold" | "manual";
}

export interface ReinvestmentEvent {
  timestamp: number;
  targetPosition: string;
  amount0: bigint;
  amount1: bigint;
  reason: string;
  strategy: string;
  profitabilityScore: number;
}

export interface FeeCollectionAnalytics {
  totalFeesCollected0: bigint;
  totalFeesCollected1: bigint;
  totalReinvestmentEvents: number;
  averageProfitabilityScore: number;
  bestPerformingPosition: PositionProfitability | null;
  worstPerformingPosition: PositionProfitability | null;
  totalReinvestedValue: number;
  feeCollectionEfficiency: number; // Percentage of available fees collected
  reinvestmentEfficiency: number; // ROI of reinvestments
}

export interface PositionManager {
  // Core position operations
  getPosition(positionId: string): any;
  collectFees(positionId: string): { fee0: bigint; fee1: bigint } | null;
  addToPosition(positionId: string, amount0: bigint, amount1: bigint): any;
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
  | { action: "wait"; message: string }
  | {
      action: "collect_fees";
      message: string;
      feesCollected: { fee0: bigint; fee1: bigint };
      positionsAffected: string[];
    }
  | {
      action: "reinvest";
      message: string;
      reinvestmentDetails: ReinvestmentEvent;
    };

export interface CustomReinvestmentStrategy {
  name: string;
  selectTargetPosition(
    positions: PositionProfitability[],
    availableAmount0: bigint,
    availableAmount1: bigint,
    context: any
  ): string | null;
}

export interface FeeCollectionState {
  lastFeeCollection: number;
  lastReinvestment: number;
  positionProfitabilityHistory: Map<string, PositionProfitability[]>;
  feeCollectionHistory: FeeCollectionEvent[];
  reinvestmentHistory: ReinvestmentEvent[];
  customStrategies: Map<string, CustomReinvestmentStrategy>;
}
