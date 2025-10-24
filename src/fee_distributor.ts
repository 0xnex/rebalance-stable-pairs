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
      console.log("[FeeDistributor] No active positions in range");
      return;
    }

    // Calculate total liquidity from in-range positions
    const totalLiquidity = inRangePositions.reduce((sum, pos) => sum + pos.L, 0n);

    if (totalLiquidity === 0n) {
      console.log("[FeeDistributor] No active liquidity");
      return;
    }

    // Determine which token fee to distribute
    const fee0 = swapEvent.zeroForOne ? swapEvent.feeAmount : 0n;
    const fee1 = swapEvent.zeroForOne ? 0n : swapEvent.feeAmount;

    if (fee0 === 0n && fee1 === 0n) {
      return; // No fees to distribute
    }

    // Distribute fees proportionally to each position
    this.distributeFees(fee0, fee1, inRangePositions, totalLiquidity);
  }

  /**
   * Distribute fees directly to in-range positions based on their liquidity share
   */
  private distributeFees(
    fee0: bigint,
    fee1: bigint,
    inRangePositions: IPosition[],
    totalLiquidity: bigint
  ): void {
    let distributedFee0 = 0n;
    let distributedFee1 = 0n;

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
    }

    console.log(
      `[FeeDistributor] Distributed fees: fee0=${fee0}, fee1=${fee1} ` +
      `to ${inRangePositions.length} positions (totalLiquidity=${totalLiquidity})`
    );
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

