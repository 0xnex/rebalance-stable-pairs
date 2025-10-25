import type { IFeeDistributor, SwapEvent, IPosition } from "./types";

/**
 * Simple FeeDistributor - directly distributes fees to in-range positions
 * No global state tracking needed - just calculate and distribute on each swap
 */
export class FeeDistributor implements IFeeDistributor {
  // Reference to positions for updating
  private positions: Map<string, IPosition>;

  // Current tick for determining which positions are in range
  private currentTick: number = 0;

  // Accumulated fees that are too small to distribute
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;

  // Minimum fee threshold - fees below this are accumulated until threshold is reached
  private readonly MIN_FEE_THRESHOLD: bigint = 1000n;

  constructor(positions: Map<string, IPosition>) {
    this.positions = positions;
  }

  /**
   * Handle swap event - distribute fees to all in-range positions
   */
  onSwapEvent(swapEvent: SwapEvent): void {
    this.currentTick = swapEvent.tick;

    // Get in-range positions
    const inRangePositions = this.getInRangePositions();

    if (inRangePositions.length === 0) {
      const allPositions = Array.from(this.positions.values());
      const totalPositions = allPositions.length;
      const closedPositions = allPositions.filter(p => p.isClosed).length;
      const openPositions = allPositions.filter(p => !p.isClosed).length;
      const positionsWithLiquidity = allPositions.filter(p => !p.isClosed && p.L > 0n).length;
      const positionsInRange = allPositions.filter(p => !p.isClosed && p.isInRange(this.currentTick)).length;

      // Get position details for debugging
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
        `[total=${totalPositions}] [open=${openPositions}] [closed=${closedPositions}] ` +
        `[with_liquidity=${positionsWithLiquidity}] [in_range=${positionsInRange}] [fee=${swapEvent.feeAmount}] ` +
        `[details=${positionDetails || "none"}]`
      );
      return;
    }

    // Calculate total liquidity from in-range positions
    const totalLiquidity = inRangePositions.reduce((sum, pos) => sum + pos.L, 0n);

    if (totalLiquidity === 0n) {
      const positionIds = inRangePositions.map(p => p.id).join(", ");
      console.log(
        `[FEE_DIST] [no_liquidity] [current_tick=${this.currentTick}] ` +
        `[in_range_positions=${inRangePositions.length}] [positions=${positionIds}]`
      );
      return;
    }

    // Determine which token fee to distribute
    let fee0 = swapEvent.zeroForOne ? swapEvent.feeAmount : 0n;
    let fee1 = swapEvent.zeroForOne ? 0n : swapEvent.feeAmount;

    // Add accumulated fees from previous swaps
    fee0 += this.accumulatedFee0;
    fee1 += this.accumulatedFee1;

    if (fee0 === 0n && fee1 === 0n) {
      return; // No fees to distribute
    }

    // Check if fees meet minimum threshold for distribution
    const shouldDistributeFee0 = fee0 >= this.MIN_FEE_THRESHOLD;
    const shouldDistributeFee1 = fee1 >= this.MIN_FEE_THRESHOLD;

    if (!shouldDistributeFee0 && !shouldDistributeFee1) {
      // Accumulate small fees for later distribution
      this.accumulatedFee0 = fee0;
      this.accumulatedFee1 = fee1;
      console.log(
        `[FEE_DIST] [accumulated] [current_tick=${this.currentTick}] ` +
        `[fee0=${swapEvent.zeroForOne ? swapEvent.feeAmount : 0n}] ` +
        `[fee1=${swapEvent.zeroForOne ? 0n : swapEvent.feeAmount}] ` +
        `[total_accumulated0=${this.accumulatedFee0}] [total_accumulated1=${this.accumulatedFee1}] ` +
        `[threshold=${this.MIN_FEE_THRESHOLD}] [reason=below_threshold]`
      );
      return;
    }

    // Distribute only fees that meet threshold
    const distributeFee0 = shouldDistributeFee0 ? fee0 : 0n;
    const distributeFee1 = shouldDistributeFee1 ? fee1 : 0n;

    // Keep fees below threshold accumulated
    this.accumulatedFee0 = shouldDistributeFee0 ? 0n : fee0;
    this.accumulatedFee1 = shouldDistributeFee1 ? 0n : fee1;

    // Distribute fees proportionally to each position
    this.distributeFees(distributeFee0, distributeFee1, inRangePositions, totalLiquidity, swapEvent);
  }

  /**
   * Distribute fees directly to in-range positions based on their liquidity share
   */
  private distributeFees(
    fee0: bigint,
    fee1: bigint,
    inRangePositions: IPosition[],
    totalLiquidity: bigint,
    swapEvent: SwapEvent
  ): void {
    let distributedFee0 = 0n;
    let distributedFee1 = 0n;

    // Track per-position distributions for logging
    const positionDistributions: Array<{
      id: string;
      lower: number;
      upper: number;
      liquidity: bigint;
      fee0: bigint;
      fee1: bigint;
      share: number;
    }> = [];

    // Distribute to each position proportionally
    for (let i = 0; i < inRangePositions.length; i++) {
      const position = inRangePositions[i];
      if (!position) continue; // Safety check

      const isLastPosition = i === inRangePositions.length - 1;

      let positionFee0 = 0n;
      let positionFee1 = 0n;

      if (fee0 > 0n) {
        if (isLastPosition) {
          // Give remaining to last position to avoid rounding dust
          positionFee0 = fee0 - distributedFee0;
        } else {
          positionFee0 = (fee0 * position.L) / totalLiquidity;
          distributedFee0 += positionFee0;
        }
      }

      if (fee1 > 0n) {
        if (isLastPosition) {
          // Give remaining to last position to avoid rounding dust
          positionFee1 = fee1 - distributedFee1;
        } else {
          positionFee1 = (fee1 * position.L) / totalLiquidity;
          distributedFee1 += positionFee1;
        }
      }

      if (positionFee0 > 0n || positionFee1 > 0n) {
        position.updateFee(positionFee0, positionFee1);
      }

      // Calculate liquidity share percentage
      const share = Number((position.L * 10000n) / totalLiquidity) / 100;

      positionDistributions.push({
        id: position.id,
        lower: position.lower,
        upper: position.upper,
        liquidity: position.L,
        fee0: positionFee0,
        fee1: positionFee1,
        share,
      });
    }

    // Log overall distribution summary
    const positionList = inRangePositions.map(p =>
      `${p.id}[${p.lower}:${p.upper}](L=${p.L})`
    ).join(", ");

    console.log(
      `[FEE_DIST] [distributed] [current_tick=${this.currentTick}] ` +
      `[fee0=${fee0}] [fee1=${fee1}] [positions=${inRangePositions.length}] ` +
      `[position_liquidity=${totalLiquidity}] [pool_liquidity=${swapEvent.liquidity}] [to=${positionList}]`
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

  /**
   * Calculate and update fees for a specific position
   * Note: In this simple implementation, fees are distributed on each swap,
   * so this method doesn't need to do anything additional
   */
  distributeFee(positionId: string): void {
    // Fees are already distributed on each swap event
    // This method is kept for interface compatibility
  }

  /**
   * Distribute accumulated fees to a position before it closes
   * This ensures the position receives any small accumulated fees that haven't reached the threshold yet
   */
  distributeAccumulatedFeesOnClose(position: IPosition): void {
    if (position.isClosed || position.L === 0n) {
      return; // Position is already closed or has no liquidity
    }

    // Check if position is in range and there are accumulated fees
    const isInRange = position.isInRange(this.currentTick);
    if (!isInRange) {
      return; // Out of range positions don't get accumulated fees
    }

    // Get all currently active in-range positions
    const inRangePositions = this.getInRangePositions();
    if (inRangePositions.length === 0) {
      return;
    }

    // Calculate total liquidity
    const totalLiquidity = inRangePositions.reduce((sum, pos) => sum + pos.L, 0n);
    if (totalLiquidity === 0n) {
      return;
    }

    // Only distribute if there are accumulated fees
    if (this.accumulatedFee0 === 0n && this.accumulatedFee1 === 0n) {
      return;
    }

    // Calculate this position's share of accumulated fees
    let positionFee0 = 0n;
    let positionFee1 = 0n;

    if (this.accumulatedFee0 > 0n) {
      positionFee0 = (this.accumulatedFee0 * position.L) / totalLiquidity;
    }

    if (this.accumulatedFee1 > 0n) {
      positionFee1 = (this.accumulatedFee1 * position.L) / totalLiquidity;
    }

    // Update position with its share
    if (positionFee0 > 0n || positionFee1 > 0n) {
      position.updateFee(positionFee0, positionFee1);

      // Reduce accumulated fees by the amount distributed
      this.accumulatedFee0 -= positionFee0;
      this.accumulatedFee1 -= positionFee1;

      const share = Number((position.L * 10000n) / totalLiquidity) / 100;
      
      console.log(
        `[FEE_DIST] [on_close] [id=${position.id}] [current_tick=${this.currentTick}] ` +
        `[distributed_accumulated_fee0=${positionFee0}] [distributed_accumulated_fee1=${positionFee1}] ` +
        `[remaining_accumulated_fee0=${this.accumulatedFee0}] [remaining_accumulated_fee1=${this.accumulatedFee1}] ` +
        `[share=${share.toFixed(2)}%]`
      );
    }
  }

  /**
   * Get all positions that are currently active at the current tick
   * Note: This checks if currentTick is within [lower, upper] range
   * 
   * For maximum accuracy, you could track liquidity at each tick,
   * but for backtesting/simulation, checking range inclusion is sufficient.
   */
  private getInRangePositions(): IPosition[] {
    return Array.from(this.positions.values()).filter(
      (pos) => !pos.isClosed && pos.L > 0n && pos.isInRange(this.currentTick)
    );
  }

  /**
   * Initialize fee tracking for a new position
   * Note: No initialization needed in simple implementation
   */
  initializePosition(positionId: string): void {
    // No state to initialize in simple implementation
  }

  /**
   * Remove position from fee tracking
   * Note: No state to clean up in simple implementation
   */
  removePosition(positionId: string): void {
    // No state to clean up in simple implementation
  }
}

