export interface SwapEvent {
  timestamp: number;
  poolId: string;
  amountIn: bigint;
  amountOut: bigint;
  zeroForOne: boolean;
  sqrtPriceBefore: bigint;
  sqrtPriceAfter: bigint;
  feeAmount: bigint;
  liquidity: bigint;
  tick: number;
  reserveA: bigint;
  reserveB: bigint;
}

export interface SwapEventListener {
  onSwapEvent(swapEvent: SwapEvent): void;
}

// 流动性计算结果类型
export interface MaxLResult {
  L: bigint;
  amount0Used: bigint;
  amount1Used: bigint;
  fee0: bigint;
  fee1: bigint;
  slip0: bigint;
  slip1: bigint;
}

// Swap 结果类型
export interface SwapResult {
  amountOut: bigint;
  fee: bigint;
  slippage: bigint;
}

// 流动性优化结果类型
export interface OptimizationResult {
  needSwap: boolean;
  swapDirection: "0to1" | "1to0" | null;
  swapAmount: bigint;
  swapResult?: SwapResult;
  finalAmount0: bigint; // swap 后的最终 token0 持有量
  finalAmount1: bigint; // swap 后的最终 token1 持有量
  maxLResult: MaxLResult;
  improvement: {
    originalL: bigint;
    optimizedL: bigint;
    improvementPct: number;
  };
  // Convenience fields for remaining amounts
  remainingAmount0: bigint; // finalAmount0 - amount0Used
  remainingAmount1: bigint; // finalAmount1 - amount1Used
}

export interface IPool extends SwapEventListener {
  getTick(): number;
  price(): number;
  
  swap(amountIn: bigint, xForY: boolean): SwapResult;

  optimizeForMaxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): OptimizationResult;

  removeLiquidity(
    deltaLiquidity: bigint,
    lower: number,
    upper: number
  ): { amount0: bigint; amount1: bigint };
}

export interface ISlippageProvider extends SwapEventListener {
  getSlippagePct(amountIn: bigint, xForY: boolean, price: number): number;
}

export interface IPosition {
  // Identity
  id: string;
  lower: number;
  upper: number;
  
  // Initial investment
  initialAmount0: bigint;
  initialAmount1: bigint;
  
  // Cached amounts (updated by PositionManager)
  amount0: bigint;
  amount1: bigint;
  
  // Final amounts when closed (for performance calculation)
  finalAmount0: bigint;
  finalAmount1: bigint;
  
  // Fees (integer values, rounded down from high-precision)
  fee0: bigint;
  fee1: bigint;
  accumulatedFee0: bigint;
  accumulatedFee1: bigint;
  
  // Costs
  cost0: bigint;
  cost1: bigint;
  slip0: bigint;
  slip1: bigint;
  
  // State
  L: bigint;
  isClosed: boolean;
  openTime: number;
  closeTime: number;
  
  // In-range tracking (managed by PositionManager)
  lastTickUpdateTime: number;
  lastWasInRange: boolean;
  totalInRangeTimeMs: number;
  
  // Cumulative tracking across rebalances (persists when position is recreated)
  cumulativeOpenTime: number; // First time this position ID was ever opened
  cumulativeTotalInRangeTimeMs: number; // Total in-range time across all iterations
  cumulativeInitialAmount0: bigint; // Total invested amount0 across all iterations
  cumulativeInitialAmount1: bigint; // Total invested amount1 across all iterations
  
  // Simple query methods (no side effects)
  getValue(price: number): bigint;
  isInRange(currentTick: number): boolean;
}

export interface IPositionManager {
  openPosition(id: string, lower: number, upper: number): void;
  addLiquidity(
    id: string,
    amount0: bigint,
    amount1: bigint
  ): { liquidity: bigint; amount0Used: bigint; amount1Used: bigint };
  closePosition(id: string): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  };
  fee(id: string): { fee0: bigint; fee1: bigint };
  claimFee(id: string): { fee0: bigint; fee1: bigint };
  getPosition(id: string): IPosition;
  getPositions(): IPosition[];
  getActivePositions(): IPosition[];
  updateFee(id: string, fee0: bigint, fee1: bigint): void;
  // Balance access methods
  getBalance0(): bigint;
  getBalance1(): bigint;
  // Time management
  setCurrentTime(timestamp: number): void;
}

export interface ICompounder extends SwapEventListener {
  // check if canCompound per SwapEvent
}

export interface BacktestContext {
  readonly pool: IPool;
  readonly positionManager: IPositionManager;
  readonly currentTime: number;
}

export interface IStrategy {
  onStart(context: BacktestContext): void;
  onEnd(context: BacktestContext): void;
  onTick(timestamp: number, context: BacktestContext): void;
}

/**
 * Extended strategy interface with CLI parameter support
 * Strategies can define their own CLI parameters
 */
export interface IStrategyFactory {
  // Strategy metadata
  name: string;
  description: string;
  
  // CLI parameter definitions
  cliParams?: {
    name: string;           // e.g., "band1-width"
    description: string;    // Help text
    type: "number" | "string" | "boolean";
    defaultValue?: any;
  }[];
  
  // Factory method to create strategy with parsed params
  create(params: Record<string, any>): IStrategy;
}

export interface FundPerformance {
  timestamp: number;
  initialAmount0: bigint;
  initialAmount1: bigint;
  initialValue: bigint; // in token1
  currentBalance0: bigint;
  currentBalance1: bigint;
  totalPositionValue: bigint; // in token1
  totalFeeEarned: bigint; // in token1
  totalValue: bigint; // in token1
  pnl: bigint; // in token1
  roiPercent: number;
  totalSlippageCost: bigint; // in token1
  totalSwapCost: bigint; // in token1
  currentPrice: number;
}

export interface PositionPerformance {
  timestamp: number;
  positionId: string;
  lowerTick: number;
  upperTick: number;
  status: 'active' | 'closed';
  isInRange: boolean;
  liquidity: bigint;
  initialAmount0: bigint;
  initialAmount1: bigint;
  initialValue: bigint; // in token1
  currentAmount0: bigint;
  currentAmount1: bigint;
  positionValue: bigint; // in token1
  fee0: bigint;
  fee1: bigint;
  totalFeeEarned: bigint; // in token1
  pnl: bigint; // in token1
  roiPercent: number;
  apr: number; // Annualized percentage rate
  apy: number; // Annual percentage yield (compounded)
  openTime: number; // Timestamp when position opened
  closeTime: number; // Timestamp when position closed (0 if still open)
  durationMs: number; // Time position has been open
  durationDays: number; // Duration in days
  inRangeTimeMs: number; // Time spent in range
  inRangePercent: number; // Percentage of time in range
  slippage0: bigint;
  slippage1: bigint;
  slippageCost: bigint; // in token1
  swapCost0: bigint;
  swapCost1: bigint;
  swapCost: bigint; // in token1
  currentPrice: number;
}

export const Q64 = 1n << 64n;
export const PPM = 1000000;
export const BPS = 10000;