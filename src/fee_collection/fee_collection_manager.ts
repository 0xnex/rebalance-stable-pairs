/**
 * Simple Fee Collection Manager
 * Periodically collects fees and reinvests them into the most profitable position
 */

import type {
  PositionManager,
  PriceProvider,
  FeeCollectionAction,
} from "./types";

interface SimpleFeeCollectionConfig {
  feeCollectionIntervalMs: number;
  minimalTokenAAmount: bigint;
  minimalTokenBAmount: bigint;
}

export class FeeCollectionManager {
  private config: SimpleFeeCollectionConfig;
  private lastFeeCollection: number = 0;
  private positionManager: PositionManager;
  private priceProvider: PriceProvider;

  constructor(
    positionManager: PositionManager,
    priceProvider: PriceProvider,
    config: SimpleFeeCollectionConfig
  ) {
    this.positionManager = positionManager;
    this.priceProvider = priceProvider;
    this.config = config;
  }

  /**
   * Main execution method - call this from your strategy's execute() method
   */
  execute(currentTime: number = Date.now()): FeeCollectionAction {
    // Check if it's time to collect fees
    if (
      currentTime - this.lastFeeCollection <
      this.config.feeCollectionIntervalMs
    ) {
      return {
        action: "none",
        message: "Waiting for next fee collection interval",
      };
    }

    // Check if we have enough fees to collect
    const totals = this.positionManager.getTotals();
    const unclaimedFeesA = totals.feesOwed0 ?? 0n;
    const unclaimedFeesB = totals.feesOwed1 ?? 0n;

    if (
      unclaimedFeesA < this.config.minimalTokenAAmount &&
      unclaimedFeesB < this.config.minimalTokenBAmount
    ) {
      return {
        action: "none",
        message: "Insufficient fees to collect",
      };
    }

    // Collect fees and reinvest
    return this.collectAndReinvest(currentTime);
  }

  /**
   * Collect fees from all positions and reinvest into most profitable position
   */
  private collectAndReinvest(currentTime: number): FeeCollectionAction {
    // Step 1: Collect fees from all positions
    let totalFee0 = 0n;
    let totalFee1 = 0n;
    const positionsAffected: string[] = [];

    const positions = this.positionManager.getActivePositions();
    for (const position of positions) {
      try {
        const fees = this.positionManager.collectFees(position.id);
        if (fees && (fees.fee0 > 0n || fees.fee1 > 0n)) {
          totalFee0 += fees.fee0;
          totalFee1 += fees.fee1;
          positionsAffected.push(position.id);
        }
      } catch (err) {
        console.warn(
          `Failed to collect fees from position ${position.id}:`,
          err
        );
      }
    }

    this.lastFeeCollection = currentTime;

    // Step 2: Find most profitable position (currently in range)
    const currentTick = this.priceProvider.getCurrentTick();
    let mostProfitablePosition = null;

    for (const position of positions) {
      const isInRange =
        currentTick >= position.tickLower && currentTick < position.tickUpper;
      if (isInRange) {
        mostProfitablePosition = position;
        console.log(
          `[FeeCollection] Found in-range position ${position.id} at tick ${currentTick} (range: ${position.tickLower}-${position.tickUpper})`
        );
        break; // First in-range position is considered most profitable
      }
    }

    // Step 3: Handle reinvestment based on position availability
    if (totalFee0 > 0n || totalFee1 > 0n) {
      if (!mostProfitablePosition) {
        // No position in range - collect fees but don't reinvest
        console.log(
          `[FeeCollection] No position in range at tick ${currentTick}. Collected fees will remain as cash until a position comes in range.`
        );
        console.log(
          `[FeeCollection] Available positions: ${positions
            .map((p) => `${p.id}[${p.tickLower}-${p.tickUpper}]`)
            .join(", ")}`
        );

        return {
          action: "collect_fees",
          message: `Collected ${Number(totalFee0)} tokenA and ${Number(
            totalFee1
          )} tokenB from ${
            positionsAffected.length
          } positions. Pending reinvestment - no position in range at tick ${currentTick}`,
          feesCollected: { fee0: totalFee0, fee1: totalFee1 },
          positionsAffected,
        };
      }

      // Position in range found - proceed with reinvestment
      try {
        this.positionManager.addToPosition(
          mostProfitablePosition.id,
          totalFee0,
          totalFee1
        );
        console.log(
          `[FeeCollection] Successfully reinvested ${Number(
            totalFee0
          )} tokenA + ${Number(totalFee1)} tokenB into in-range position ${
            mostProfitablePosition.id
          }`
        );

        return {
          action: "collect_and_reinvest",
          message: `Collected ${Number(totalFee0)} tokenA + ${Number(
            totalFee1
          )} tokenB from ${
            positionsAffected.length
          } positions and reinvested into in-range position ${
            mostProfitablePosition.id
          }`,
          feesCollected: { fee0: totalFee0, fee1: totalFee1 },
          positionsAffected,
        };
      } catch (err) {
        console.warn(
          `[FeeCollection] Failed to reinvest into position ${mostProfitablePosition.id}:`,
          err
        );
        return {
          action: "collect_fees",
          message: `Collected fees but failed to reinvest: ${
            (err as Error).message
          }`,
          feesCollected: { fee0: totalFee0, fee1: totalFee1 },
          positionsAffected,
        };
      }
    }

    return {
      action: "none",
      message: "No fees collected or no position available for reinvestment",
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<SimpleFeeCollectionConfig>) {
    this.config = { ...this.config, ...newConfig };
  }
}
