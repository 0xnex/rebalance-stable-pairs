import type { IPosition, SwapEvent } from "./types";

/**
 * Fee Distribution Service
 * 
 * Pure functions for calculating and distributing fees to positions.
 * This service is stateless - all state is managed by the caller (PositionManager).
 * 
 * Uses fixed-point arithmetic with PRECISION_FACTOR to preserve fractional fees.
 * Fees are accumulated with full precision and only rounded down when claimed.
 */

// Precision factor for fixed-point arithmetic (10^18)
// This allows us to track fractional fees with high precision
export const PRECISION_FACTOR = 10n ** 18n;

export interface FeeDistributionResult {
  distributed: boolean;
  reason?: string;
  positionFees: Map<string, { fee0: bigint; fee1: bigint }>; // High-precision fees (scaled by PRECISION_FACTOR)
}

export class FeeDistributionService {
  constructor() {
    // No config needed - we always distribute fees with high precision
  }

  /**
   * Calculate fee distribution for a swap event
   * 
   * @param swapEvent - The swap event containing fee information
   * @param inRangePositions - Positions that are in range
   * @param currentTick - Current pool tick
   * @returns FeeDistributionResult with high-precision fees
   */
  distributeFees(
    swapEvent: SwapEvent,
    inRangePositions: IPosition[],
    currentTick: number
  ): FeeDistributionResult {
    // Check if we have any positions
    if (inRangePositions.length === 0) {
      return {
        distributed: false,
        reason: "no_positions_in_range",
        positionFees: new Map(),
      };
    }

    const poolLiquidity = swapEvent.liquidity;
    if (poolLiquidity === 0n) {
      return {
        distributed: false,
        reason: "zero_pool_liquidity",
        positionFees: new Map(),
      };
    }

    // Convert swap fee to high-precision
    const fee0 = swapEvent.zeroForOne ? swapEvent.feeAmount * PRECISION_FACTOR : 0n;
    const fee1 = swapEvent.zeroForOne ? 0n : swapEvent.feeAmount * PRECISION_FACTOR;

    if (fee0 === 0n && fee1 === 0n) {
      return {
        distributed: false,
        reason: "no_fees",
        positionFees: new Map(),
      };
    }

    // Calculate fees for each position with high precision
    const positionFees = new Map<string, { fee0: bigint; fee1: bigint }>();

    for (const position of inRangePositions) {
      if (!position) continue;

      let positionFee0 = 0n;
      let positionFee1 = 0n;

      // Calculate fee based on position's share of TOTAL POOL LIQUIDITY
      // Result is in high-precision (scaled by PRECISION_FACTOR)
      if (fee0 > 0n) {
        positionFee0 = (fee0 * position.L) / poolLiquidity;
      }

      if (fee1 > 0n) {
        positionFee1 = (fee1 * position.L) / poolLiquidity;
      }

      if (positionFee0 > 0n || positionFee1 > 0n) {
        positionFees.set(position.id, { fee0: positionFee0, fee1: positionFee1 });
      }
    }

    return {
      distributed: true,
      positionFees,
    };
  }

  /**
   * Calculate share percentage of pool liquidity
   */
  calculateShare(positionLiquidity: bigint, poolLiquidity: bigint): number {
    if (poolLiquidity === 0n) return 0;
    return Number((positionLiquidity * 10000n) / poolLiquidity) / 100;
  }
}

