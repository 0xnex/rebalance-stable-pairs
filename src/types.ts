export interface SwapEvent {
  timestamp: number;
  poolId: string;
  amountIn: bigint;
  amountOut: bigint;
  zeroForOne: boolean;
  newSqrtPrice: bigint;
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
}

export interface IPool extends SwapEventListener {
  swap(amountIn: bigint, xForY: boolean): SwapResult;

  maxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): MaxLResult;

  optimizeForMaxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): OptimizationResult;
}

export interface ISlippageProvider extends SwapEventListener {
  getSlippagePct(amountIn: bigint, xForY: boolean, price: number): number;
}

export interface IPosition {
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
  getPosition(id: string): Position;
  getPositions(): Position[];
  getActivePositions(): Position[];
  updateFee(id: string, fee0: bigint, fee1: bigint): void;
}

export interface IFeeDistributor extends SwapEventListener {
  distributeFee(id: string): void;
}

export interface ICompounder extends SwapEventListener {
  // check if canCompound per SwapEvent
}

export interface IWallet {
  amount0(): bigint;
  amount1(): bigint;
  fee0(): bigint;
  fee1(): bigint;
}

export interface IStrategy {
  onStart(): void;
  onEnd(): void;
  onSwapEvent(swapEvent: SwapEvent): void;
}
