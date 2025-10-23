// ============================================================================
// IMPROVED TYPES.TS - 完整的系统类型定义
// ============================================================================

// ============================================================================
// 基础事件和监听器类型
// ============================================================================

export interface SwapEvent {
  timestamp: number;
  poolId: string;
  amountIn: bigint;
  amountOut: bigint;
  zeroForOne: boolean;
  newSqrtPrice: bigint;
  feeAmount: bigint;
  liquidity?: bigint;
  tick?: number;
  reserveA?: bigint;
  reserveB?: bigint;
}

export interface SwapEventListener {
  onSwapEvent(swapEvent: SwapEvent): void;
}

// ============================================================================
// 池相关接口
// ============================================================================

export interface IPool extends SwapEventListener {
  // 基础属性获取
  getPrice(): number;
  getTimestamp(): number;
  getSqrtPriceX64(): bigint;
  getTickSpacing(): number;
  getTick(): number;
  getFeeTier(): number;
  getToken0(): string;
  getToken1(): string;
  getToken0Decimals(): number;
  getToken1Decimals(): number;
  getLiquidity(): bigint;

  // 交易相关
  swap(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    feeAmount: bigint;
    priceImpact: number;
    newSqrtPrice: bigint;
  };

  // 估算功能
  estimateAmountOut(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    feeAmount: bigint;
    priceImpact: number;
  };

  // 价格转换
  tickToSqrtPrice(tick: number): bigint;
  sqrtPriceToTick(sqrtPrice: bigint): number;
}

export interface ISlippageProvider extends SwapEventListener {
  getSlippagePct(amountIn: bigint, zeroForOne: boolean, price: number): number;
}

// ============================================================================
// 仓位相关接口
// ============================================================================

export interface IPosition {
  id: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  createdAt: number;

  // 计算方法
  getValue(price: number): bigint;
  isInRange(currentTick: number): boolean;
}

export interface PositionCreateResult {
  positionId: string;
  liquidity: bigint;
  usedTokenA: bigint;
  usedTokenB: bigint;
  returnTokenA: bigint;
  returnTokenB: bigint;
  slippage: number;
  gasFee: bigint;
}

export interface AddLiquidityResult {
  success: boolean;
  addedLiquidity: bigint;
  totalLiquidity: bigint;
  usedAmount0: bigint;
  usedAmount1: bigint;
  refundAmount0: bigint;
  refundAmount1: bigint;
  message?: string;
}

export interface PositionCloseResult {
  amount0: bigint;
  amount1: bigint;
  fee0: bigint;
  fee1: bigint;
}

export interface ActionCost {
  tokenA?: number;
  tokenB?: number;
  description?: string;
}

// ============================================================================
// 仓位管理器接口
// ============================================================================

export interface IPositionManager {
  // 仓位操作
  openPosition(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint,
    actionCost?: ActionCost
  ): PositionCreateResult;

  addLiquidity(
    positionId: string,
    amount0: bigint,
    amount1: bigint,
    actionCost?: ActionCost
  ): AddLiquidityResult;

  closePosition(
    positionId: string,
    actionCost?: ActionCost
  ): PositionCloseResult;
  removePosition(positionId: string, actionCost?: ActionCost): boolean;

  // 费用管理
  collectFees(positionId: string): { fee0: bigint; fee1: bigint } | null;
  updateAllPositionFees(): void;
  updatePositionFees(positionId: string): boolean;

  // 查询方法
  getPosition(positionId: string): IPosition | undefined;
  getAllPositions(): IPosition[];
  getActivePositions(): IPosition[];

  // 总计信息
  getTotals(): {
    amountA: bigint;
    amountB: bigint;
    feesOwed0: bigint;
    feesOwed1: bigint;
    positions: number;
    initialAmountA: bigint;
    initialAmountB: bigint;
    cashAmountA: bigint;
    cashAmountB: bigint;
    collectedFees0: bigint;
    collectedFees1: bigint;
    totalCostTokenA: number;
    totalCostTokenB: number;
  };

  // 余额管理
  setInitialBalances(amount0: bigint, amount1: bigint): void;
}

// ============================================================================
// 费用收集相关接口
// ============================================================================

export interface FeeCollectionConfig {
  feeCollectionIntervalMs: number;
  minimalTokenAAmount: bigint;
  minimalTokenBAmount: bigint;
}

export interface FeeCollectionResult {
  action: "none" | "collect_fees" | "collect_and_reinvest";
  message: string;
  feesCollected?: { fee0: bigint; fee1: bigint };
  positionsAffected?: string[];
}

export interface IFeeCollectionManager {
  execute(currentTime?: number): FeeCollectionResult;
  updateConfig(newConfig: Partial<FeeCollectionConfig>): void;
}

export interface IFeeDistributor extends SwapEventListener {
  distributeFee(positionId: string): void;
  processSwapFees(feeAmount0: bigint, feeAmount1: bigint): void;
}

export interface ICompounder extends SwapEventListener {
  canCompound(swapEvent: SwapEvent): boolean;
  compound(positionId: string): boolean;
}

// ============================================================================
// 价格提供者接口
// ============================================================================

export interface IPriceProvider {
  getCurrentPrice(): number;
  getCurrentTick(): number;
  getHistoricalPrice(timestamp: number): number | undefined;
}

// ============================================================================
// 钱包和资金管理接口
// ============================================================================

export interface IWallet {
  // 代币余额
  getAmount0(): bigint;
  getAmount1(): bigint;

  // 费用余额
  getFee0(): bigint;
  getFee1(): bigint;

  // 总价值计算
  getTotalValue(price: number): bigint;

  // 余额操作
  updateBalance(amount0Delta: bigint, amount1Delta: bigint): void;
}

export interface GlobalFundState {
  cash0: bigint;
  cash1: bigint;
  inPosition0: bigint;
  inPosition1: bigint;
  unclaimedFees0: bigint;
  unclaimedFees1: bigint;
  total0: bigint;
  total1: bigint;
  totalValue: bigint;
}

// ============================================================================
// 策略相关接口
// ============================================================================

export interface IStrategy {
  id: string;

  // 生命周期方法
  onStart(): void | Promise<void>;
  onEnd(): void | Promise<void>;

  // 事件处理
  onSwapEvent(swapEvent: SwapEvent): void;
  onTick?(timestamp: number): void;

  // 执行方法
  execute(): StrategyExecutionResult;

  // 配置管理
  updateConfig(config: any): void;
  getConfig(): any;
}

export interface StrategyExecutionResult {
  action: "none" | "wait" | "create" | "rebalance" | "collect_fees";
  message: string;
  data?: any;
}

export interface StrategyContext {
  timestamp: number;
  logger?: {
    log?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}

// ============================================================================
// 回测相关接口
// ============================================================================

export interface BacktestConfig {
  startTime: number;
  endTime: number;
  initialAmountA: bigint;
  initialAmountB: bigint;
  strategy: IStrategy;
  pool: IPool;
}

export interface BacktestResult {
  totalReturn: number;
  totalValue: bigint;
  finalAmountA: bigint;
  finalAmountB: bigint;
  totalFees: { fee0: bigint; fee1: bigint };
  executionTime: number;
  transactionCount: number;
}

export interface IBacktestEngine {
  run(config: BacktestConfig): Promise<BacktestResult>;
  addEventSource(source: SwapEventListener): void;
  removeEventSource(source: SwapEventListener): void;
}

// ============================================================================
// 报告和分析接口
// ============================================================================

export interface PerformanceMetrics {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  volatility: number;
  winRate: number;
}

export interface PositionAnalytics {
  totalPositions: number;
  activePositions: number;
  totalLiquidity: bigint;
  totalValue: bigint;
  totalFees: { fee0: bigint; fee1: bigint };
  averagePositionSize: bigint;
}

export interface IReportGenerator {
  generatePerformanceReport(): PerformanceMetrics;
  generatePositionReport(): PositionAnalytics;
  exportToCSV(filePath: string): void;
}

// ============================================================================
// 流动性估算相关接口
// ============================================================================

export interface LiquiditySnapshot {
  timestamp: number;
  activeLiquidity: bigint;
  estimatedTotalLiquidity: bigint;
  price: number;
  tick: number;
}

export interface ILiquidityEstimator {
  processSwapEvent(event: SwapEvent): void;
  getEstimatedTotalLiquidity(): bigint;
  getLiquidityAtTime(timestamp: number): bigint | undefined;
  getStats(): {
    minLiquidity: bigint;
    maxLiquidity: bigint;
    avgLiquidity: bigint;
    totalSnapshots: number;
  };
}

// ============================================================================
// 错误和异常类型
// ============================================================================

export interface StrategyError {
  code: string;
  message: string;
  timestamp: number;
  context?: any;
}

export interface ValidationResult {
  isValid: boolean;
  errors: StrategyError[];
  warnings: string[];
}

// ============================================================================
// 配置相关类型
// ============================================================================

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface PoolConfig {
  token0: TokenConfig;
  token1: TokenConfig;
  feeTier: number;
  tickSpacing: number;
}

export interface StrategyConfig {
  name: string;
  version: string;
  parameters: Record<string, any>;
  riskLimits: {
    maxPositionSize: bigint;
    maxSlippage: number;
    maxDrawdown: number;
  };
}

// ============================================================================
// 实用类型
// ============================================================================

export type Timestamp = number;
export type PositionId = string;
export type PoolId = string;
export type TokenAmount = bigint;
export type Price = number;
export type Tick = number;
export type Percentage = number;

// 联合类型
export type EventType =
  | "swap"
  | "addLiquidity"
  | "removeLiquidity"
  | "collectFees";
export type PositionStatus = "active" | "inactive" | "closed";
export type StrategyStatus = "running" | "paused" | "stopped" | "error";

// 条件类型
export type OptionalFields<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

// ============================================================================
// 向后兼容的类型别名（用于渐进式迁移）
// ============================================================================

/** @deprecated 使用 IPosition 替代 */
export type Position = IPosition;

/** @deprecated 使用 IPositionManager 替代 */
export type PositionManager = IPositionManager;

/** @deprecated 使用 IPriceProvider 替代 */
export type PriceProvider = IPriceProvider;
