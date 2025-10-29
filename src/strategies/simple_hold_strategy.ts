/**
 * Simple Hold Strategy
 *
 * A basic strategy that creates a single wide position at initialization
 * and holds it for the entire backtest period.
 *
 * Purpose: Test the backtest framework and verify fee distribution logic.
 */

import type {
  BacktestStrategy,
  StrategyContext,
  SwapEvent,
} from "../backtest_engine";

export type SimpleHoldConfig = {
  positionId: string;
  tickLower: number;
  tickUpper: number;
  initialAmount0: bigint;
  initialAmount1: bigint;
};

export class SimpleHoldStrategy implements BacktestStrategy {
  readonly id = "simple-hold";
  private config: SimpleHoldConfig;
  private positionCreated = false;

  constructor(config: SimpleHoldConfig) {
    this.config = config;
  }

  onInit(ctx: StrategyContext): void {
    console.log(
      `[SimpleHoldStrategy] Initializing at timestamp ${ctx.timestamp}, ` +
        `tick=${ctx.pool.tickCurrent}, price=${ctx.pool.price.toFixed(6)}`
    );

    // Create a single wide position
    try {
      const position = ctx.manager.createPosition(
        this.config.positionId,
        this.config.tickLower,
        this.config.tickUpper,
        this.config.initialAmount0,
        this.config.initialAmount1,
        ctx.timestamp
      );

      this.positionCreated = true;

      console.log(
        `[SimpleHoldStrategy] Created position: ` +
          `id=${position.id}, ` +
          `tickRange=[${position.tickLower}, ${position.tickUpper}], ` +
          `liquidity=${position.liquidity.toString()}`
      );
    } catch (error) {
      console.error(`[SimpleHoldStrategy] Failed to create position:`, error);
    }
  }

  onTick(ctx: StrategyContext): void {
    // Just log status periodically (every 1000 ticks = ~16 minutes at 1s intervals)
    if (ctx.stepIndex % 1000 === 0) {
      const totals = ctx.manager.getTotals();
      const position = ctx.manager.getPosition(this.config.positionId);

      if (position) {
        const positionTotals = position.getTotals(ctx.pool.sqrtPriceX64);

        console.log(
          `[SimpleHoldStrategy] Status at step ${ctx.stepIndex}: ` +
            `price=${ctx.pool.price.toFixed(6)}, ` +
            `tick=${ctx.pool.tickCurrent}, ` +
            `inRange=${position.isInRange(ctx.pool.tickCurrent)}, ` +
            `feesOwed0=${positionTotals.fee0.toString()}, ` +
            `feesOwed1=${positionTotals.fee1.toString()}, ` +
            `totalValue=${
              Number(totals.amountA) * ctx.pool.price + Number(totals.amountB)
            }`
        );
      }
    }
  }

  onSwapEvent(ctx: StrategyContext, event: SwapEvent): void {
    // Optional: Log when price moves in/out of range
    const position = ctx.manager.getPosition(this.config.positionId);
    if (!position) return;

    const wasInRange = position.isInRange(
      Math.floor((ctx.pool.tickCurrent + event.tick) / 2) // Approximate previous tick
    );
    const isInRange = position.isInRange(ctx.pool.tickCurrent);

    if (wasInRange !== isInRange) {
      console.log(
        `[SimpleHoldStrategy] Position range status changed: ` +
          `${wasInRange ? "IN→OUT" : "OUT→IN"} at tick ${ctx.pool.tickCurrent}`
      );
    }
  }

  onFinish(ctx: StrategyContext): void {
    console.log(`[SimpleHoldStrategy] Finishing at timestamp ${ctx.timestamp}`);

    if (this.positionCreated) {
      const position = ctx.manager.getPosition(this.config.positionId);
      if (position) {
        const positionTotals = position.getTotals(ctx.pool.sqrtPriceX64);

        console.log(
          `[SimpleHoldStrategy] Final position status: ` +
            `liquidity=${position.liquidity.toString()}, ` +
            `feesOwed0=${positionTotals.fee0.toString()}, ` +
            `feesOwed1=${positionTotals.fee1.toString()}`
        );

        // Close the position
        const result = ctx.manager.closePosition(this.config.positionId);

        console.log(
          `[SimpleHoldStrategy] Position closed: ` +
            `returned amount0=${result.amount0.toString()}, ` +
            `amount1=${result.amount1.toString()}, ` +
            `fee0=${result.fee0.toString()}, ` +
            `fee1=${result.fee1.toString()}`
        );
      }
    }

    const finalTotals = ctx.manager.getTotals();
    console.log(
      `[SimpleHoldStrategy] Final totals: ` +
        `cash0=${finalTotals.cashAmountA.toString()}, ` +
        `cash1=${finalTotals.cashAmountB.toString()}, ` +
        `collectedFees0=${finalTotals.collectedFees0.toString()}, ` +
        `collectedFees1=${finalTotals.collectedFees1.toString()}`
    );
  }
}

/**
 * Factory function for SimpleHoldStrategy
 */
export function createSimpleHoldStrategy(
  tickLower: number,
  tickUpper: number,
  initialAmount0: bigint,
  initialAmount1: bigint
): SimpleHoldStrategy {
  return new SimpleHoldStrategy({
    positionId: "simple-hold-position",
    tickLower,
    tickUpper,
    initialAmount0,
    initialAmount1,
  });
}
