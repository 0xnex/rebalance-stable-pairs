import { type IPositionManager, type IPosition, type IPool, type SwapEvent } from "./types";
import { FeeDistributionService, PRECISION_FACTOR } from "./fee_distribution_service";

/**
 * Position - Simple data holder for liquidity position state
 * All operations are handled by PositionManager
 */
class Position implements IPosition {
  public readonly id: string;
  public readonly lower: number;
  public readonly upper: number;
  public initialAmount0: bigint = 0n;
  public initialAmount1: bigint = 0n;
  
  // Cached token amounts (updated by PositionManager when liquidity changes)
  public amount0: bigint = 0n;
  public amount1: bigint = 0n;
  
  // Final amounts when closed (for performance calculation)
  public finalAmount0: bigint = 0n;
  public finalAmount1: bigint = 0n;
  
  // High-precision fee tracking (scaled by PRECISION_FACTOR)
  // Public for PositionManager direct access
  public highPrecisionFee0: bigint = 0n;
  public highPrecisionFee1: bigint = 0n;
  public highPrecisionAccumulatedFee0: bigint = 0n;
  public highPrecisionAccumulatedFee1: bigint = 0n;
  
  // Integer fee accessors (rounded down from high-precision)
  get fee0(): bigint {
    return this.highPrecisionFee0 / PRECISION_FACTOR;
  }
  
  get fee1(): bigint {
    return this.highPrecisionFee1 / PRECISION_FACTOR;
  }
  
  get accumulatedFee0(): bigint {
    return this.highPrecisionAccumulatedFee0 / PRECISION_FACTOR;
  }
  
  get accumulatedFee1(): bigint {
    return this.highPrecisionAccumulatedFee1 / PRECISION_FACTOR;
  }
  
  public cost0: bigint = 0n;
  public cost1: bigint = 0n;
  public slip0: bigint = 0n;
  public slip1: bigint = 0n;
  public L: bigint = 0n;
  public isClosed: boolean = false;
  public openTime: number = 0;
  public closeTime: number = 0;
  
  // In-range time tracking (managed by PositionManager)
  public lastTickUpdateTime: number = 0;
  public lastWasInRange: boolean = false;
  public totalInRangeTimeMs: number = 0;
  
  // Cumulative tracking across rebalances (persists when position is recreated)
  public cumulativeOpenTime: number = 0; // First time this position ID was ever opened
  public cumulativeTotalInRangeTimeMs: number = 0; // Total in-range time across all iterations
  public cumulativeInitialAmount0: bigint = 0n; // Total invested amount0 across all iterations
  public cumulativeInitialAmount1: bigint = 0n; // Total invested amount1 across all iterations

  constructor(id: string, lower: number, upper: number) {
    this.id = id;
    this.lower = lower;
    this.upper = upper;
  }

  /**
   * Check if position is in range at given tick
   * Pure function - no side effects
   */
  isInRange(currentTick: number): boolean {
    return currentTick >= this.lower && currentTick <= this.upper;
  }

  /**
   * Get value of position at given price (for reporting)
   */
  getValue(price: number): bigint {
    return (this.amount0 + this.fee0) * BigInt(Math.floor(price)) + (this.amount1 + this.fee1);
  }
}

class PositionManager implements IPositionManager {
  private initialAmount0: bigint = 0n;
  private initialAmount1: bigint = 0n;

  private balance0: bigint;
  private balance1: bigint;
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;

  private positions: Map<string, IPosition> = new Map();
  
  private pool: IPool;
  
  // Fee distribution
  private feeService: FeeDistributionService;
  private currentTick: number = 0;
  private currentPoolLiquidity: bigint = 0n;
  private currentTime: number = 0; // Track simulation time (initialized in constructor)

  constructor(amount0: bigint, amount1: bigint, pool: IPool, initialTime?: number) {
    this.initialAmount0 = amount0;
    this.initialAmount1 = amount1;
    this.balance0 = amount0;
    this.balance1 = amount1;
    this.pool = pool;
    this.feeService = new FeeDistributionService();
    // Set initial simulation time (defaults to current time if not provided, for tests)
    this.currentTime = initialTime !== undefined ? initialTime : Date.now();
  }

  openPosition(id: string, lower: number, upper: number): void {
    let pos = this.positions.get(id);
    
    if (pos && !pos.isClosed) {
      throw new Error(`Position ${id} already exists and is not closed`);
    }

    if (!pos) {
      pos = new Position(id, lower, upper);
      // First time opening this position ID
      pos.cumulativeOpenTime = this.currentTime;
    } else {
      // Reopening a closed position - need to create new Position with new range
      // because lower/upper are readonly fields
      const oldPos = pos;
      const newPos = new Position(id, lower, upper);
      pos = newPos;
      
      // Carry over cumulative metrics from old position
      // Note: cumulativeOpenTime and cumulativeInitialAmount represent the FIRST opening
      // and should not be re-accumulated when rebalancing (same capital being redeployed)
      newPos.cumulativeOpenTime = oldPos.cumulativeOpenTime || oldPos.openTime;
      newPos.cumulativeTotalInRangeTimeMs = oldPos.cumulativeTotalInRangeTimeMs + oldPos.totalInRangeTimeMs;
      newPos.cumulativeInitialAmount0 = oldPos.cumulativeInitialAmount0 || oldPos.initialAmount0;
      newPos.cumulativeInitialAmount1 = oldPos.cumulativeInitialAmount1 || oldPos.initialAmount1;
      
      // Accumulate fees and costs (cast to Position to access internal fields)
      const oldPosition = oldPos as Position;
      newPos.highPrecisionAccumulatedFee0 = oldPosition.highPrecisionAccumulatedFee0;
      newPos.highPrecisionAccumulatedFee1 = oldPosition.highPrecisionAccumulatedFee1;
      newPos.cost0 = oldPos.cost0;
      newPos.cost1 = oldPos.cost1;
      newPos.slip0 = oldPos.slip0;
      newPos.slip1 = oldPos.slip1;
      
      this.positions.set(id, newPos);
    }

    // Set open time using current simulation time
    pos.openTime = this.currentTime;
    
    // Initialize in-range tracking to current time and tick
    // This ensures time from position open to first swap is counted
    pos.lastTickUpdateTime = this.currentTime;
    pos.lastWasInRange = pos.isInRange(this.currentTick);
    
    const openTimeStr = new Date(pos.openTime).toISOString();

    console.log(
      `[OPEN_POSITION] [id=${id}] [lower=${lower}] [upper=${upper}] ` +
      `[time=${openTimeStr}] [timestamp=${pos.openTime}]`
    );
    this.positions.set(id, pos);
  }

  addLiquidity(id: string, amount0: bigint, amount1: bigint): { liquidity: bigint; amount0Used: bigint; amount1Used: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as Position;

    if (position.isClosed) {
      throw new Error(`Position ${id} is closed`);
    }

    // Check sufficient balance
    if (this.balance0 < amount0 || this.balance1 < amount1) {
      throw new Error(
        `[POSITION_MGR] [insufficient_balance] ` +
        `[requested_amount0=${amount0}] [available=${this.balance0}] ` +
        `[requested_amount1=${amount1}] [available=${this.balance1}]`
      );
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
    
    // Update liquidity
    const liquidityToAdd = optimizationResult.maxLResult.L;
    position.L += liquidityToAdd;
    
    // Update cached amounts after liquidity change
    this.updatePositionAmounts(position);
    
    // Log warning if liquidity is zero
    if (liquidityToAdd === 0n) {
      console.log(
        `[POSITION_MGR] [warning] [zero_liquidity_added] ` +
        `[id=${id}] [input_amount0=${amount0}] [input_amount1=${amount1}] ` +
        `[final_amount0=${optimizationResult.maxLResult.amount0Used}] ` +
        `[final_amount1=${optimizationResult.maxLResult.amount1Used}] ` +
        `[range=${position.lower}:${position.upper}] [current_tick=${(this.pool as any).tick}]`
      );
    }
    
    // Deduct input amounts from balance (swap + liquidity all come from input)
    this.balance0 -= amount0;
    this.balance1 -= amount1;
    
    // Return unused amounts back to balance (important for rebalancing!)
    const remainingAmount0 = optimizationResult.remainingAmount0 ?? (optimizationResult.finalAmount0 - optimizationResult.maxLResult.amount0Used);
    const remainingAmount1 = optimizationResult.remainingAmount1 ?? (optimizationResult.finalAmount1 - optimizationResult.maxLResult.amount1Used);
    this.balance0 += remainingAmount0;
    this.balance1 += remainingAmount1;
    
    if (this.balance0 < 0n || this.balance1 < 0n) {
      throw new Error(`[POSITION_MGR] [insufficient_balance_after_deduction] [balance0=${this.balance0}] [balance1=${this.balance1}]`);
    }
    
    // Log if significant amounts were unused
    if (remainingAmount0 > amount0 / 10n || remainingAmount1 > amount1 / 10n) {
      console.log(
        `[POSITION_MGR] [unused_amounts_returned] [id=${id}] ` +
        `[remaining0=${remainingAmount0}] [remaining1=${remainingAmount1}] ` +
        `[input0=${amount0}] [input1=${amount1}]`
      );
    }
    
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
    const position = this.positions.get(id) as Position;
    
    if (position.L < liquidity) {
      throw new Error(`Position ${id} has not enough liquidity`);
    }

    // Calculate amounts for the liquidity being removed
    const amounts = this.pool.removeLiquidity(liquidity, position.lower, position.upper);
    
    // Update position liquidity
    position.L -= liquidity;
    
    // Update cached amounts after liquidity change
    this.updatePositionAmounts(position);
    
    // Return removed amounts to balance
    this.balance0 += amounts.amount0;
    this.balance1 += amounts.amount1;
    
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
    const position = this.positions.get(id) as Position;
    
    // Note: in-range time has already been updated by setCurrentTime() before this is called
    // No need to update again here
    
    // Get current amounts before closing
    const finalAmount0 = position.amount0;
    const finalAmount1 = position.amount1;
    
    // Claim all accumulated fees (rounded down)
    const claimable0 = position.highPrecisionFee0 / PRECISION_FACTOR;
    const claimable1 = position.highPrecisionFee1 / PRECISION_FACTOR;
    
    // Keep only the fractional parts
    position.highPrecisionFee0 = position.highPrecisionFee0 % PRECISION_FACTOR;
    position.highPrecisionFee1 = position.highPrecisionFee1 % PRECISION_FACTOR;
    
    // Store final amounts for performance calculation (before clearing)
    position.finalAmount0 = finalAmount0;
    position.finalAmount1 = finalAmount1;
    
    // Mark as closed and clear state, using current simulation time
    position.isClosed = true;
    position.closeTime = this.currentTime;
    position.L = 0n;
    position.amount0 = 0n;
    position.amount1 = 0n;
    
    // Log close time and duration
    const closeTimeStr = new Date(position.closeTime).toISOString();
    const durationMs = position.closeTime - position.openTime;
    const durationHours = (durationMs / (1000 * 60 * 60)).toFixed(2);
    const durationDays = (durationMs / (1000 * 60 * 60 * 24)).toFixed(2);
    
    console.log(
      `[CLOSE_POSITION] [id=${id}] [time=${closeTimeStr}] [timestamp=${position.closeTime}] ` +
      `[duration_hours=${durationHours}] [duration_days=${durationDays}]`
    );
    
    // Return all amounts and fees to balance
    this.balance0 += finalAmount0 + claimable0;
    this.balance1 += finalAmount1 + claimable1;
    
    return { 
      amount0: finalAmount0, 
      amount1: finalAmount1, 
      fee0: claimable0, 
      fee1: claimable1 
    };
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
    const position = this.positions.get(id) as Position;
    
    // Claim fees (returns integer amounts, keeps fractional parts)
    const claimable0 = position.highPrecisionFee0 / PRECISION_FACTOR;
    const claimable1 = position.highPrecisionFee1 / PRECISION_FACTOR;
    
    // Keep only the fractional parts
    position.highPrecisionFee0 = position.highPrecisionFee0 % PRECISION_FACTOR;
    position.highPrecisionFee1 = position.highPrecisionFee1 % PRECISION_FACTOR;
    
    // Add claimed fees to balance
    this.balance0 += claimable0;
    this.balance1 += claimable1;
    
    console.log(
      `[CLAIM_FEE] [id=${id}] [fee0=${claimable0}] [fee1=${claimable1}]`
    );
    
    return { fee0: claimable0, fee1: claimable1 };
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
    const position = this.positions.get(id) as Position;
    this.updatePositionFee(position, fee0, fee1); // Use helper method
    
    // Track accumulated fees in PositionManager as integer amounts
    const integerFee0 = fee0 / PRECISION_FACTOR;
    const integerFee1 = fee1 / PRECISION_FACTOR;
    this.accumulatedFee0 += integerFee0;
    this.accumulatedFee1 += integerFee1;
  }

  isActive(id: string): boolean {
    return this.positions.has(id) && !this.positions.get(id)?.isClosed;
  }

  /**
   * Handle swap event - distribute fees to all in-range positions
   */
  onSwapEvent(swapEvent: SwapEvent): void {
    this.currentTick = swapEvent.tick;
    this.currentPoolLiquidity = swapEvent.liquidity;
    this.currentTime = swapEvent.timestamp; // Track simulation time
    
    // Update in-range time tracking for all positions
    for (const position of this.positions.values()) {
      if (!position.isClosed) {
        this.updatePositionInRangeTime(position as Position, swapEvent.tick, swapEvent.timestamp);
      }
    }
    
    // Distribute fees
    this.distributeFees(swapEvent);
  }

  /**
   * Set the current simulation time (used by backtest engine for final timestamp)
   * Also updates in-range time for all positions to account for time since last swap
   */
  setCurrentTime(timestamp: number): void {
    // Update in-range time for all positions before changing current time
    for (const position of this.positions.values()) {
      if (!position.isClosed) {
        this.updatePositionInRangeTime(position as Position, this.currentTick, timestamp);
      }
    }
    
    this.currentTime = timestamp;
  }

  /**
   * Get available balance of token0
   */
  getBalance0(): bigint {
    return this.balance0;
  }

  /**
   * Get available balance of token1
   */
  getBalance1(): bigint {
    return this.balance1;
  }

  /**
   * Get all positions that are currently active at the current tick
   */
  private getInRangePositions(): IPosition[] {
    return Array.from(this.positions.values()).filter(
      (pos) => !pos.isClosed && pos.L > 0n && pos.isInRange(this.currentTick)
    );
  }

  /**
   * Update position fee internally (replaces position.updateFee())
   */
  private updatePositionFee(position: Position, fee0: bigint, fee1: bigint): void {
    // fee0 and fee1 are already in high precision (scaled by PRECISION_FACTOR)
    position.highPrecisionFee0 += fee0;
    position.highPrecisionFee1 += fee1;
    position.highPrecisionAccumulatedFee0 += fee0;
    position.highPrecisionAccumulatedFee1 += fee1;
  }

  /**
   * Update in-range time tracking internally (replaces position.updateInRangeTime())
   */
  private updatePositionInRangeTime(position: Position, currentTick: number, currentTime: number): void {
    if (position.lastTickUpdateTime === 0) {
      // First update - initialize
      position.lastTickUpdateTime = currentTime;
      position.lastWasInRange = position.isInRange(currentTick);
      return;
    }
    
    const timeElapsed = currentTime - position.lastTickUpdateTime;
    
    // Defensive check: ignore negative or unreasonably large time gaps
    if (timeElapsed < 0) {
      console.log(`[WARNING] [negative_time_elapsed] [position=${position.id}] [elapsed=${timeElapsed}] [current=${currentTime}] [last=${position.lastTickUpdateTime}]`);
      position.lastTickUpdateTime = currentTime;
      position.lastWasInRange = position.isInRange(currentTick);
      return;
    }
    
    if (position.lastWasInRange && timeElapsed > 0) {
      position.totalInRangeTimeMs += timeElapsed;
    }
    
    position.lastTickUpdateTime = currentTime;
    position.lastWasInRange = position.isInRange(currentTick);
  }

  /**
   * Update cached amount0/amount1 from position liquidity
   */
  private updatePositionAmounts(position: Position): void {
    if (position.L === 0n) {
      position.amount0 = 0n;
      position.amount1 = 0n;
      return;
    }
    
    const amounts = this.pool.removeLiquidity(position.L, position.lower, position.upper);
    position.amount0 = amounts.amount0;
    position.amount1 = amounts.amount1;
  }

  /**
   * Distribute fees from a swap event to in-range positions
   */
  private distributeFees(swapEvent: SwapEvent): void {
    const inRangePositions = this.getInRangePositions();

    // Use fee service to calculate distribution
    const result = this.feeService.distributeFees(
      swapEvent,
      inRangePositions,
      this.currentTick
    );

    // Handle no distribution scenarios
    if (!result.distributed) {
      if (result.reason === "no_positions_in_range") {
        const allPositions = Array.from(this.positions.values());
        const positionDetails = allPositions
          .filter(p => !p.isClosed)
          .map(p => {
            const inRange = p.isInRange(this.currentTick);
            const hasLiq = p.L > 0n;
            return `${p.id}[${p.lower}:${p.upper}](L=${p.L},inRange=${inRange},hasLiq=${hasLiq})`;
          })
          .join(", ");

        console.log(
          `[FEE_DIST] [no_positions_in_range] [current_tick=${this.currentTick}] ` +
          `[total=${allPositions.length}] [open=${allPositions.filter(p => !p.isClosed).length}] ` +
          `[closed=${allPositions.filter(p => p.isClosed).length}] ` +
          `[with_liquidity=${allPositions.filter(p => !p.isClosed && p.L > 0n).length}] ` +
          `[in_range=${allPositions.filter(p => !p.isClosed && p.isInRange(this.currentTick)).length}] ` +
          `[fee=${swapEvent.feeAmount}] [details=${positionDetails || "none"}]`
        );
      } else if (result.reason === "zero_pool_liquidity") {
        console.log(
          `[FEE_DIST] [zero_pool_liquidity] [current_tick=${this.currentTick}] ` +
          `[positions=${inRangePositions.length}]`
        );
      }
      return;
    }

    // Apply fees to positions
    const positionDistributions: Array<{
      id: string;
      lower: number;
      upper: number;
      liquidity: bigint;
      fee0: bigint; // Actual token amount (not high precision)
      fee1: bigint; // Actual token amount (not high precision)
      share: number;
    }> = [];

    for (const position of inRangePositions) {
      const fees = result.positionFees.get(position.id);
      if (fees && (fees.fee0 > 0n || fees.fee1 > 0n)) {
        // Update position with high-precision fees using helper
        this.updatePositionFee(position as Position, fees.fee0, fees.fee1);

        const share = this.feeService.calculateShare(position.L, swapEvent.liquidity);
        
        // Convert to actual token amounts for logging
        const actualFee0 = fees.fee0 / PRECISION_FACTOR;
        const actualFee1 = fees.fee1 / PRECISION_FACTOR;
        
        positionDistributions.push({
          id: position.id,
          lower: position.lower,
          upper: position.upper,
          liquidity: position.L,
          fee0: actualFee0,
          fee1: actualFee1,
          share,
        });
      }
    }

    // Calculate total distributed (in actual token amounts)
    const ourTotalLiquidity = inRangePositions.reduce((sum, pos) => sum + pos.L, 0n);
    const totalFee0 = Array.from(result.positionFees.values()).reduce((sum, f) => sum + f.fee0, 0n) / PRECISION_FACTOR;
    const totalFee1 = Array.from(result.positionFees.values()).reduce((sum, f) => sum + f.fee1, 0n) / PRECISION_FACTOR;
    const positionList = inRangePositions.map(p =>
      `${p.id}[${p.lower}:${p.upper}](L=${p.L})`
    ).join(", ");

    console.log(
      `[FEE_DIST] [distributed] [current_tick=${this.currentTick}] ` +
      `[fee0=${totalFee0}] [fee1=${totalFee1}] [positions=${inRangePositions.length}] ` +
      `[position_liquidity=${ourTotalLiquidity}] [pool_liquidity=${swapEvent.liquidity}] [to=${positionList}]`
    );

    // Log per-position distributions
    for (const dist of positionDistributions) {
      console.log(
        `[FEE_DIST] [position] [id=${dist.id}] [range=${dist.lower}:${dist.upper}] ` +
        `[liquidity=${dist.liquidity}] [share=${dist.share.toFixed(2)}%] ` +
        `[received_fee0=${dist.fee0}] [received_fee1=${dist.fee1}]`
      );
    }
  }
}

export { PositionManager, Position };
