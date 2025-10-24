import type { IStrategy, BacktestContext, Position } from "../types";

/**
 * Example strategy that demonstrates the basic pattern:
 * 1. Opens a position at start
 * 2. Monitors position range on each tick
 * 3. Rebalances when price moves out of range
 */
export class ExampleStrategy implements IStrategy {
  private readonly positionId = "example-position";
  private readonly rangeWidthTicks = 200; // Width of liquidity range
  private rebalanceCount = 0;

  /**
   * Called once at the start of the backtest
   */
  onStart(context: BacktestContext): void {
    console.log("\n[STRATEGY] [example] [started]");
    console.log(`[STRATEGY] [initial_tick] [${context.pool.getCurrentTick()}]`);
    console.log(`[STRATEGY] [initial_price] [${context.pool.getCurrentPrice()}]`);
    console.log(`[STRATEGY] [token0] [${context.pool.getToken0Name()}]`);
    console.log(`[STRATEGY] [token1] [${context.pool.getToken1Name()}]`);

    // Open initial position centered around current price
    this.openCenteredPosition(context);
  }

  /**
   * Called every tick interval (default: 1 second)
   */
  onTick(timestamp: number, context: BacktestContext): void {
    const position = context.positionManager.getPosition(this.positionId);
    
    if (!position || position.status !== "open") {
      return;
    }

    const currentTick = context.pool.getCurrentTick();
    const inRange = this.isInRange(position, currentTick);

    if (!inRange) {
      // Price moved out of range - rebalance
      console.log(
        `[STRATEGY] [out_of_range] ` +
        `[tick=${currentTick}] ` +
        `[range=${position.tickLower}:${position.tickUpper}] ` +
        `[time=${new Date(timestamp).toISOString()}]`
      );

      // Close old position and open new centered position
      context.positionManager.closePosition(this.positionId);
      this.openCenteredPosition(context);
      this.rebalanceCount++;

      console.log(
        `[STRATEGY] [rebalanced] ` +
        `[count=${this.rebalanceCount}] ` +
        `[new_range=${currentTick - this.rangeWidthTicks / 2}:${currentTick + this.rangeWidthTicks / 2}]`
      );
    }
  }

  /**
   * Called once at the end of the backtest
   */
  onEnd(context: BacktestContext): void {
    console.log("\n[STRATEGY] [example] [completed]");
    
    const finalTick = context.pool.getCurrentTick();
    const finalPrice = context.pool.getCurrentPrice();
    const positions = context.positionManager.getAllPositions();
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();

    console.log(`[STRATEGY] [final_tick] [${finalTick}]`);
    console.log(`[STRATEGY] [final_price] [${finalPrice}]`);
    console.log(`[STRATEGY] [rebalance_count] [${this.rebalanceCount}]`);
    console.log(`[STRATEGY] [total_positions] [${positions.length}]`);
    console.log(`[STRATEGY] [final_balance0] [${balance0}]`);
    console.log(`[STRATEGY] [final_balance1] [${balance1}]`);

    // Close any open positions
    for (const pos of positions) {
      if (!pos.isClosed) {
        context.positionManager.closePosition(pos.id);
      }
    }
  }

  /**
   * Helper: Open a position centered around current tick
   */
  private openCenteredPosition(context: BacktestContext): void {
    const currentTick = context.pool.getCurrentTick();
    const tickSpacing = 10; // Match pool's tick spacing
    
    // Align tick to spacing
    const alignedTick = Math.floor(currentTick / tickSpacing) * tickSpacing;
    
    // Calculate range bounds
    const halfWidth = Math.floor(this.rangeWidthTicks / 2 / tickSpacing) * tickSpacing;
    const tickLower = alignedTick - halfWidth;
    const tickUpper = alignedTick + halfWidth;

    // Use all available balance
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();

    console.log(
      `[STRATEGY] [opening_position] ` +
      `[id=${this.positionId}] ` +
      `[range=${tickLower}:${tickUpper}] ` +
      `[amount0=${balance0}] ` +
      `[amount1=${balance1}]`
    );

    context.positionManager.openPosition(
      this.positionId,
      tickLower,
      tickUpper
    );
    context.positionManager.addLiquidity(
      this.positionId,
      balance0,
      balance1
    );
  }

  /**
   * Helper: Check if current tick is within position range
   */
  private isInRange(position: Position, currentTick: number): boolean {
    return currentTick >= position.lower && currentTick < position.upper;
  }
}

