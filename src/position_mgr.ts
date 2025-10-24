import { type IPositionManager, type IPosition, type IPool, type SwapEvent, type FundPerformance, type PositionPerformance } from "./types";
import { FeeDistributor } from "./fee_distributor";
import { exportPerformanceToCSV } from "./performance_exporter";

class Position implements IPosition {
  public readonly id: string;
  public readonly lower: number;
  public readonly upper: number;
  public initialAmount0: bigint = 0n;
  public initialAmount1: bigint = 0n; 
  public fee0: bigint = 0n;
  public fee1: bigint = 0n;
  public accumulatedFee0: bigint = 0n;
  public accumulatedFee1: bigint = 0n;
  public cost0: bigint = 0n;
  public cost1: bigint = 0n;
  public slip0: bigint = 0n;
  public slip1: bigint = 0n;
  public L: bigint = 0n;
  public isClosed: boolean = false;

  private pool: IPool;

  constructor(id: string, lower: number, upper: number, pool: IPool) {
    this.id = id;
    this.lower = lower;
    this.upper = upper;
    this.pool = pool;
  }

  // Calculated property - derives amounts from liquidity
  get amount0(): bigint {
    if (this.L === 0n) return 0n;
    const amounts = this.pool.removeLiquidity(this.L, this.lower, this.upper);
    return amounts.amount0;
  }

  get amount1(): bigint {
    if (this.L === 0n) return 0n;
    const amounts = this.pool.removeLiquidity(this.L, this.lower, this.upper);
    return amounts.amount1;
  }

  getValue(price: number): bigint {
    return (
      (this.amount0 + this.fee0) * BigInt(price) + (this.amount1 + this.fee1)
    );
  }

  isInRange(currentTick: number): boolean {
    return currentTick >= this.lower && currentTick <= this.upper;
  }

  updateFee(fee0: bigint, fee1: bigint): void {
    this.fee0 += fee0;
    this.fee1 += fee1;
    this.accumulatedFee0 += fee0;
    this.accumulatedFee1 += fee1;
  }

  close(): { amount0: bigint; amount1: bigint; fee0: bigint; fee1: bigint } {
    this.isClosed = true;
    const finalAmount0 = this.amount0;
    const finalAmount1 = this.amount1;
    this.L = 0n; // Clear liquidity
    const collectedFee0 = this.fee0;
    const collectedFee1 = this.fee1;
    this.fee0 = 0n;
    this.fee1 = 0n;
    return { amount0: finalAmount0, amount1: finalAmount1, fee0: collectedFee0, fee1: collectedFee1 };
  }
}

class PositionManager implements IPositionManager {
  private initialAmount0: bigint = 0n;
  private initialAmount1: bigint = 0n;
  private balance0: bigint = 0n; // balance of token0
  private balance1: bigint = 0n; // balance of token1
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;
  private positions: Map<string, IPosition> = new Map();
  private pool: IPool;
  private feeDistributor: FeeDistributor;

  constructor(amount0: bigint, amount1: bigint, pool: IPool) {
    this.initialAmount0 = amount0;
    this.initialAmount1 = amount1;
    this.balance0 = amount0;
    this.balance1 = amount1;
    this.pool = pool;
    this.feeDistributor = new FeeDistributor(this.positions);
  }

  openPosition(id: string, lower: number, upper: number): void {
    let pos = this.positions.get(id);
    
    if (pos && !pos.isClosed) {
      throw new Error(`Position ${id} already exists and is not closed`);
    }

    if (!pos) {
      pos = new Position(id, lower, upper, this.pool);
    }

    console.log("[OPEN POSITION]", id, lower, upper);
    this.positions.set(id, pos);
    
    // Initialize fee tracking for this position
    this.feeDistributor.initializePosition(id);
  }

  addLiquidity(id: string, amount0: bigint, amount1: bigint): { liquidity: bigint; amount0Used: bigint; amount1Used: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;

    if (position.isClosed) {
      throw new Error(`Position ${id} is closed`);
    }

    const optimizationResult = this.pool.optimizeForMaxL(
      amount0,
      amount1,
      position.lower,
      position.upper
    );

    if (optimizationResult.needSwap) {
      // record swap stat
      console.log(
        "[SWAP]",
        id,
        optimizationResult.swapDirection,
        optimizationResult.swapAmount,
        optimizationResult.swapResult?.amountOut,
        optimizationResult.swapResult?.fee,
        optimizationResult.swapResult?.slippage
      );

      if (optimizationResult.swapDirection === "0to1") {
        position.cost0 += optimizationResult.swapResult?.fee ?? 0n;
        position.slip1 += optimizationResult.swapResult?.slippage ?? 0n;
      } else {
        position.cost1 += optimizationResult.swapResult?.fee ?? 0n;
        position.slip0 += optimizationResult.swapResult?.slippage ?? 0n;
      }
    }
    position.initialAmount0 += amount0;
    position.initialAmount1 += amount1;
    // Only update liquidity - amounts are calculated on demand
    position.L += optimizationResult.maxLResult.L;
    
    return {
      liquidity: optimizationResult.maxLResult.L,
      amount0Used: optimizationResult.maxLResult.amount0Used,
      amount1Used: optimizationResult.maxLResult.amount1Used,
    };
  }

  removeLiquidity(id: string, liquidity: bigint): { amount0: bigint; amount1: bigint } {
    if (!this.isActive(id)) {
      throw new Error(`Position ${id} is not active`);
    }
    const position = this.positions.get(id) as IPosition;
    
    if (position.L < liquidity) {
      throw new Error(`Position ${id} has not enough liquidity`);
    }

    // Calculate amounts for the liquidity being removed
    const amounts = this.pool.removeLiquidity(liquidity, position.lower, position.upper);
    
    // Update position liquidity
    position.L -= liquidity;
    
    return amounts;
  }

  closePosition(id: string): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    return position.close();
  }

  fee(id: string): { fee0: bigint; fee1: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    return { fee0: position.fee0, fee1: position.fee1 };
  }

  claimFee(id: string): { fee0: bigint; fee1: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    const fees = { fee0: position.fee0, fee1: position.fee1 };
    position.fee0 = 0n;
    position.fee1 = 0n;
    return fees;
  }

  getPosition(id: string): IPosition {
    const position = this.positions.get(id);
    if (!position) {
      throw new Error(`Position ${id} does not exist`);
    }
    return position;
  }

  getPositions(): IPosition[] {
    return Array.from(this.positions.values());
  }

  getActivePositions(): IPosition[] {
    return Array.from(this.positions.values()).filter(pos => !pos.isClosed);
  }

  updateFee(id: string, fee0: bigint, fee1: bigint): void {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    position.updateFee(fee0, fee1);
    this.accumulatedFee0 += fee0;
    this.accumulatedFee1 += fee1;
  }

  isActive(id: string): boolean {
    return this.positions.has(id) && !this.positions.get(id)?.isClosed;
  }

  /**
   * Handle swap event - distribute fees to all in-range positions
   */
  onSwapEvent(swapEvent: SwapEvent): void {
    this.feeDistributor.onSwapEvent(swapEvent);
  }

  /**
   * Get fee distributor for external access
   */
  getFeeDistributor(): FeeDistributor {
    return this.feeDistributor;
  }

  /**
   * Get current pool price (token1 per token0)
   */
  private getCurrentPrice(): number {
    // Assuming pool has a price() method like SimplePool
    return (this.pool as any).price();
  }

  /**
   * Convert amount0 to token1 terms using current price
   */
  private convertToToken1(amount0: bigint, price: number): bigint {
    if (!isFinite(price) || price <= 0) {
      return 0n; // Handle invalid price
    }
    const amount0Num = Number(amount0);
    const valueInToken1 = amount0Num * price;
    if (!isFinite(valueInToken1)) {
      return 0n;
    }
    return BigInt(Math.floor(valueInToken1));
  }

  /**
   * Calculate fund-level performance metrics
   */
  getFundPerformance(): FundPerformance {
    const timestamp = Date.now();
    const currentPrice = this.getCurrentPrice();

    // Calculate initial value in token1
    const initialValue = this.convertToToken1(this.initialAmount0, currentPrice) + this.initialAmount1;

    // Calculate total position value
    const positions = this.getPositions();
    let totalPositionValue = 0n;
    let totalFeeEarned = 0n;
    let totalSlippageCost = 0n;
    let totalSwapCost = 0n;

    for (const pos of positions) {
      const posValue = this.convertToToken1(pos.amount0, currentPrice) + pos.amount1;
      const feeValue = this.convertToToken1(pos.fee0, currentPrice) + pos.fee1;
      const slippageCost = this.convertToToken1(pos.slip0, currentPrice) + pos.slip1;
      const swapCost = this.convertToToken1(pos.cost0, currentPrice) + pos.cost1;

      totalPositionValue += posValue + feeValue;
      totalFeeEarned += this.convertToToken1(pos.accumulatedFee0, currentPrice) + pos.accumulatedFee1;
      totalSlippageCost += slippageCost;
      totalSwapCost += swapCost;
    }

    // Calculate total value (balance + positions)
    const balanceValue = this.convertToToken1(this.balance0, currentPrice) + this.balance1;
    const totalValue = balanceValue + totalPositionValue;

    // Calculate PnL and ROI
    const pnl = totalValue - initialValue;
    const roiPercent = initialValue > 0n 
      ? Number((pnl * 10000n) / initialValue) / 100 
      : 0;

    return {
      timestamp,
      initialAmount0: this.initialAmount0,
      initialAmount1: this.initialAmount1,
      initialValue,
      currentBalance0: this.balance0,
      currentBalance1: this.balance1,
      totalPositionValue,
      totalFeeEarned,
      totalValue,
      pnl,
      roiPercent,
      totalSlippageCost,
      totalSwapCost,
      currentPrice,
    };
  }

  /**
   * Calculate position-level performance metrics
   */
  getPositionsPerformance(): PositionPerformance[] {
    const timestamp = Date.now();
    const currentPrice = this.getCurrentPrice();
    const currentTick = (this.pool as any).tick;

    return this.getPositions().map((pos) => {
      // Calculate initial value in token1
      const initialValue = this.convertToToken1(pos.initialAmount0, currentPrice) + pos.initialAmount1;

      // Calculate position value (amount + fees)
      const currentAmount0 = pos.amount0;
      const currentAmount1 = pos.amount1;
      const positionValue = 
        this.convertToToken1(currentAmount0, currentPrice) + 
        currentAmount1 + 
        this.convertToToken1(pos.fee0, currentPrice) + 
        pos.fee1;

      // Calculate total fee earned
      const totalFeeEarned = this.convertToToken1(pos.accumulatedFee0, currentPrice) + pos.accumulatedFee1;

      // Calculate costs
      const slippageCost = this.convertToToken1(pos.slip0, currentPrice) + pos.slip1;
      const swapCost = this.convertToToken1(pos.cost0, currentPrice) + pos.cost1;

      // Calculate PnL and ROI
      const pnl = positionValue - initialValue;
      const roiPercent = initialValue > 0n 
        ? Number((pnl * 10000n) / initialValue) / 100 
        : 0;

      return {
        timestamp,
        positionId: pos.id,
        lowerTick: pos.lower,
        upperTick: pos.upper,
        status: pos.isClosed ? 'closed' : 'active',
        isInRange: pos.isInRange(currentTick),
        liquidity: pos.L,
        initialAmount0: pos.initialAmount0,
        initialAmount1: pos.initialAmount1,
        initialValue,
        currentAmount0,
        currentAmount1,
        positionValue,
        fee0: pos.fee0,
        fee1: pos.fee1,
        totalFeeEarned,
        pnl,
        roiPercent,
        slippage0: pos.slip0,
        slippage1: pos.slip1,
        slippageCost,
        swapCost0: pos.cost0,
        swapCost1: pos.cost1,
        swapCost,
        currentPrice,
      };
    });
  }

  /**
   * Export performance data to CSV files
   */
  async exportPerformanceToCSV(outputDir: string): Promise<{
    fundCsvPath: string;
    positionsCsvPath: string;
  }> {
    const fundPerformance = this.getFundPerformance();
    const positionPerformances = this.getPositionsPerformance();

    return await exportPerformanceToCSV(
      fundPerformance,
      positionPerformances,
      outputDir
    );
  }
}

export { PositionManager, Position };
