import type { IStrategy, BacktestContext, IPosition } from "../types";

/**
 * Three-Band Pyramid Strategy
 * 
 * Strategy Logic:
 * - Three bands (positions) with widths: 2, 4, 8 ticks
 * - All bands initially centered on current pool price
 * - Only Band 1 (narrow, 2 ticks) rebalances
 * - Band 2 and Band 3 NEVER move from initial positions
 * - Rebalance trigger: Price stays outside Band 1 for 30 continuous minutes
 * - Cooldown: 5 minutes minimum between rebalances
 * 
 * Allocation: 30% / 30% / 40% for Band 1 / Band 2 / Band 3
 */

export interface ThreeBandConfig {
  // Band widths in ticks
  band1Width: number;  // Default: 2 ticks
  band2Width: number;  // Default: 4 ticks
  band3Width: number;  // Default: 8 ticks
  
  // Allocation percentages (should sum to 100)
  band1Allocation: number;  // Default: 30%
  band2Allocation: number;  // Default: 30%
  band3Allocation: number;  // Default: 40%
  
  // Rebalance controls
  outsideDurationMs: number;   // Default: 30 minutes
  cooldownMs: number;          // Default: 5 minutes
  
  // Tick spacing (must align positions to pool's tick spacing)
  tickSpacing: number;  // Default: 10
}

interface BandState {
  id: string;
  tickLower: number;
  tickUpper: number;
  width: number;
  allocation: number;
}

export class ThreeBandPyramidStrategy implements IStrategy {
  private config: ThreeBandConfig;
  
  // Position state
  private band1: BandState | null = null;
  private band2: BandState | null = null;
  private band3: BandState | null = null;
  
  // Rebalance tracking
  private outsideStartTime: number | null = null;  // When price first went outside Band 3
  private lastRebalanceTime: number = 0;           // Last time Band 1 was rebalanced
  private rebalanceCount: number = 0;
  
  constructor(config?: Partial<ThreeBandConfig>) {
    // Validate and normalize allocations
    const alloc1 = config?.band1Allocation ?? 30;
    const alloc2 = config?.band2Allocation ?? 30;
    const alloc3 = config?.band3Allocation ?? 40;
    const totalAlloc = alloc1 + alloc2 + alloc3;
    
    if (Math.abs(totalAlloc - 100) > 0.01) {
      console.log(
        `[STRATEGY] [three_band] [warning] ` +
        `[allocations_sum=${totalAlloc}] [normalizing_to_100]`
      );
    }
    
    this.config = {
      band1Width: config?.band1Width ?? 2,
      band2Width: config?.band2Width ?? 4,
      band3Width: config?.band3Width ?? 8,
      band1Allocation: (alloc1 / totalAlloc) * 100,
      band2Allocation: (alloc2 / totalAlloc) * 100,
      band3Allocation: (alloc3 / totalAlloc) * 100,
      outsideDurationMs: config?.outsideDurationMs ?? 30 * 60 * 1000, // 30 minutes
      cooldownMs: config?.cooldownMs ?? 5 * 60 * 1000, // 5 minutes
      tickSpacing: config?.tickSpacing ?? 10,
    };
  }

  onStart(context: BacktestContext): void {
    console.log("\n[STRATEGY] [three_band] [started]");
    console.log(`[STRATEGY] [config] [band_widths=${this.config.band1Width},${this.config.band2Width},${this.config.band3Width}]`);
    console.log(`[STRATEGY] [config] [allocations=${this.config.band1Allocation.toFixed(1)}%,${this.config.band2Allocation.toFixed(1)}%,${this.config.band3Allocation.toFixed(1)}%]`);
    console.log(`[STRATEGY] [config] [outside_duration=${this.config.outsideDurationMs}ms (${(this.config.outsideDurationMs / 60000).toFixed(2)}min)]`);
    console.log(`[STRATEGY] [config] [cooldown=${this.config.cooldownMs}ms (${(this.config.cooldownMs / 60000).toFixed(2)}min)]`);
    
    const currentTick = context.pool.getTick();

    console.log(`[STRATEGY] [initial_tick] [${currentTick}]`);
    
    // Create all three bands centered on current price
    this.createInitialBands(context, currentTick);
    
    this.lastRebalanceTime = context.currentTime;
  }

  onTick(timestamp: number, context: BacktestContext): void {
    const currentTick = context.pool.getTick();
    
    // Check if price is outside Band 1 (narrowest band)
    if (!this.band1) return;

    const outsideBand1 = currentTick < this.band1.tickLower || currentTick >= this.band1.tickUpper;
    
    if (outsideBand1) {
      // Price is outside Band 1
      if (this.outsideStartTime === null) {
        // Just went outside - start timer
        this.outsideStartTime = timestamp;
        console.log(
          `[STRATEGY] [price_outside_band1] ` +
          `[tick=${currentTick}] ` +
          `[band1_range=${this.band1.tickLower}:${this.band1.tickUpper}] ` +
          `[timer_started]`
        );
      } else {
        // Already outside - check duration
        const durationOutside = timestamp - this.outsideStartTime;
        
        // Check if we've been outside long enough AND passed cooldown
        if (durationOutside >= this.config.outsideDurationMs) {
          const timeSinceLastRebalance = timestamp - this.lastRebalanceTime;
          
          if (timeSinceLastRebalance >= this.config.cooldownMs) {
            // Rebalance Band 1!
            console.log(
              `[STRATEGY] [rebalance_triggered] ` +
              `[duration_outside=${(durationOutside / 60000).toFixed(1)}min] ` +
              `[cooldown_passed=${(timeSinceLastRebalance / 60000).toFixed(1)}min]`
            );
            
            this.rebalanceBand1(context, currentTick, timestamp);
            
            // Reset timer and update last rebalance time
            this.outsideStartTime = null;
            this.lastRebalanceTime = timestamp;
          } else {
            // Still in cooldown
            const cooldownRemaining = this.config.cooldownMs - timeSinceLastRebalance;
            if (Math.floor(cooldownRemaining / 1000) % 60 === 0) { // Log every minute
              console.log(
                `[STRATEGY] [cooldown_active] ` +
                `[remaining=${(cooldownRemaining / 60000).toFixed(1)}min]`
              );
            }
          }
        }
      }
    } else {
      // Price is back inside Band 1
      if (this.outsideStartTime !== null) {
        const durationWasOutside = timestamp - this.outsideStartTime;
        console.log(
          `[STRATEGY] [price_back_inside_band1] ` +
          `[tick=${currentTick}] ` +
          `[was_outside_for=${(durationWasOutside / 60000).toFixed(1)}min] ` +
          `[timer_reset]`
        );
        this.outsideStartTime = null;
      }
    }
  }

  onEnd(context: BacktestContext): void {
    console.log("\n[STRATEGY] [three_band] [completed]");
    
    const finalTick = context.pool.getTick();
    const finalPrice = context.pool.price();
    
    console.log(`[STRATEGY] [final_tick] [${finalTick}]`);
    console.log(`[STRATEGY] [final_price] [${finalPrice}]`);
    console.log(`[STRATEGY] [rebalance_count] [${this.rebalanceCount}]`);
    
    // Show final band positions
    if (this.band1) {
      console.log(`[STRATEGY] [band1_final] [${this.band1.tickLower}:${this.band1.tickUpper}]`);
    }
    if (this.band2) {
      console.log(`[STRATEGY] [band2_final] [${this.band2.tickLower}:${this.band2.tickUpper}] [never_moved]`);
    }
    if (this.band3) {
      console.log(`[STRATEGY] [band3_final] [${this.band3.tickLower}:${this.band3.tickUpper}] [never_moved]`);
    }
    
    // Close all positions
    if (this.band1) context.positionManager.closePosition(this.band1.id);
    if (this.band2) context.positionManager.closePosition(this.band2.id);
    if (this.band3) context.positionManager.closePosition(this.band3.id);
  }

  /**
   * Create initial three bands, all centered on current tick
   */
  private createInitialBands(context: BacktestContext, currentTick: number): void {
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();
    
    console.log(`[STRATEGY] [creating_bands] [balance0=${balance0}] [balance1=${balance1}]`);
    
    // Validate initial balances
    if (balance0 === 0n && balance1 === 0n) {
      throw new Error(
        `[STRATEGY] [error] Initial wallet is empty! ` +
        `Please provide initial amounts with --initial0 and --initial1`
      );
    }
    
    if (balance0 === 0n || balance1 === 0n) {
      console.log(
        `[STRATEGY] [warning] [unbalanced_wallet] ` +
        `[balance0=${balance0}] [balance1=${balance1}] ` +
        `Positions may fail to add liquidity with only one token type. ` +
        `Consider providing both token0 and token1 for optimal results.`
      );
    }
    
    // Calculate allocations
    const alloc1Amount0 = (balance0 * BigInt(Math.floor(this.config.band1Allocation))) / 100n;
    const alloc1Amount1 = (balance1 * BigInt(Math.floor(this.config.band1Allocation))) / 100n;
    
    const alloc2Amount0 = (balance0 * BigInt(Math.floor(this.config.band2Allocation))) / 100n;
    const alloc2Amount1 = (balance1 * BigInt(Math.floor(this.config.band2Allocation))) / 100n;
    
    const alloc3Amount0 = (balance0 * BigInt(Math.floor(this.config.band3Allocation))) / 100n;
    const alloc3Amount1 = (balance1 * BigInt(Math.floor(this.config.band3Allocation))) / 100n;
    
    // Band 1 (narrow, 2 ticks)
    this.band1 = this.createBand(
      context,
      "band1",
      currentTick,
      this.config.band1Width,
      this.config.band1Allocation,
      alloc1Amount0,
      alloc1Amount1
    );
    
    // Band 2 (medium, 4 ticks) - NEVER moves
    this.band2 = this.createBand(
      context,
      "band2",
      currentTick,
      this.config.band2Width,
      this.config.band2Allocation,
      alloc2Amount0,
      alloc2Amount1
    );
    
    // Band 3 (wide, 8 ticks) - NEVER moves
    this.band3 = this.createBand(
      context,
      "band3",
      currentTick,
      this.config.band3Width,
      this.config.band3Allocation,
      alloc3Amount0,
      alloc3Amount1
    );
  }

  /**
   * Create a single band centered on given tick
   */
  private createBand(
    context: BacktestContext,
    id: string,
    centerTick: number,
    width: number,
    allocation: number,
    amount0: bigint,
    amount1: bigint
  ): BandState {
    // Align to tick spacing
    const alignedCenter = Math.floor(centerTick / this.config.tickSpacing) * this.config.tickSpacing;
    
    // Calculate bounds (centered)
    const halfWidth = Math.floor(width / 2);
    const tickLower = alignedCenter - (Math.floor(halfWidth / this.config.tickSpacing) * this.config.tickSpacing);
    const tickUpper = alignedCenter + (Math.ceil(halfWidth / this.config.tickSpacing) * this.config.tickSpacing);
    
    console.log(
      `[STRATEGY] [creating_${id}] ` +
      `[range=${tickLower}:${tickUpper}] ` +
      `[width=${width}ticks] ` +
      `[allocation=${allocation.toFixed(1)}%] ` +
      `[amount0=${amount0}] ` +
      `[amount1=${amount1}]`
    );
    
    // Open position
    context.positionManager.openPosition(id, tickLower, tickUpper);
    context.positionManager.addLiquidity(id, amount0, amount1);
    
    return {
      id,
      tickLower,
      tickUpper,
      width,
      allocation,
    };
  }

  /**
   * Rebalance Band 1 to center on current tick
   */
  private rebalanceBand1(context: BacktestContext, currentTick: number, timestamp: number): void {
    if (!this.band1) return;
    
    console.log(
      `[STRATEGY] [rebalancing_band1] ` +
      `[count=${this.rebalanceCount + 1}] ` +
      `[from=${this.band1.tickLower}:${this.band1.tickUpper}] ` +
      `[current_tick=${currentTick}]`
    );
    
    // Close old Band 1 position
    const { amount0, amount1, fee0, fee1 } = context.positionManager.closePosition(this.band1.id);
    
    console.log(
      `[STRATEGY] [closed_band1] ` +
      `[amount0=${amount0}] ` +
      `[amount1=${amount1}] ` +
      `[fee0=${fee0}] ` +
      `[fee1=${fee1}]`
    );
    
    // Create new Band 1 centered on current tick
    this.band1 = this.createBand(
      context,
      "band1",
      currentTick,
      this.config.band1Width,
      this.config.band1Allocation,
      amount0 + fee0,  // Use all returned funds including fees
      amount1 + fee1
    );
    
    // Log band1 effective liquidity after rebalancing
    const band1Position = context.positionManager.getPosition("band1");
    const band1Value = Number(band1Position.amount0) + Number(band1Position.amount1);
    console.log(
      `[STRATEGY] [band1_rebalanced_liquidity] ` +
      `[amount0=${band1Position.amount0}] ` +
      `[amount1=${band1Position.amount1}] ` +
      `[total_value=${band1Value}] ` +
      `[liquidity=${band1Position.L}]`
    );
    
    this.rebalanceCount++;
    
    console.log(
      `[STRATEGY] [rebalanced_band1] ` +
      `[new_range=${this.band1.tickLower}:${this.band1.tickUpper}] ` +
      `[total_rebalances=${this.rebalanceCount}]`
    );
  }

  /**
   * Get current band states (for debugging/monitoring)
   */
  public getBandStates(): { band1: BandState | null; band2: BandState | null; band3: BandState | null } {
    return {
      band1: this.band1 ? { ...this.band1 } : null,
      band2: this.band2 ? { ...this.band2 } : null,
      band3: this.band3 ? { ...this.band3 } : null,
    };
  }

  /**
   * Get rebalance statistics
   */
  public getStats() {
    return {
      rebalanceCount: this.rebalanceCount,
      isOutsideBand3: this.outsideStartTime !== null,
      outsideDuration: this.outsideStartTime ? Date.now() - this.outsideStartTime : 0,
      lastRebalanceTime: this.lastRebalanceTime,
    };
  }
}

