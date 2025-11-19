import type { SwapEvent } from "./backtest_engine";
import type { MomentumEvent } from "./event_importer";
import {
  LiquidityCalculator,
  LiquidityConstants,
} from "./liquidity_calculator";
import type { Pool } from "./pool";

export class VirtualPosition {
  id: string;
  tickLower: number;
  tickUpper: number;
  createdAt: number;
  swapCost0: bigint = 0n;
  swapCost1: bigint = 0n;
  slippage0: bigint = 0n;
  slippage1: bigint = 0n;

  tokensOwed0: bigint = 0n;
  tokensOwed1: bigint = 0n;
  liquidity: bigint = 0n;
  isClosed: boolean = false;

  constructor(
    id: string,
    tickLower: number,
    tickUpper: number,
    createdAt: number
  ) {
    this.id = id;
    this.tickLower = tickLower;
    this.tickUpper = tickUpper;
    this.createdAt = createdAt;
  }

  isInRange(tick: number): boolean {
    return tick >= this.tickLower && tick < this.tickUpper;
  }

  addLiquidity(amount: bigint): void {
    this.liquidity += amount;
  }

  removeLiquidity(
    amount: bigint,
    sqrtPriceCurrent: bigint
  ): { amount0: bigint; amount1: bigint } {
    if (amount > this.liquidity) {
      throw new Error("Insufficient liquidity");
    }

    this.liquidity -= amount;
    return LiquidityCalculator.calculateAmountsForLiquidity(
      amount,
      sqrtPriceCurrent,
      LiquidityCalculator.tickToSqrtPriceX64(this.tickLower),
      LiquidityCalculator.tickToSqrtPriceX64(this.tickUpper)
    );
  }

  close(sqrtPriceCurrent: bigint): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    const fee0 = this.tokensOwed0;
    const fee1 = this.tokensOwed1;
    this.tokensOwed0 = 0n;
    this.tokensOwed1 = 0n;
    const { amount0, amount1 } = this.removeLiquidity(
      this.liquidity,
      sqrtPriceCurrent
    );
    return { amount0, amount1, fee0, fee1 };
  }

  collectFees(): { fee0: bigint; fee1: bigint } {
    const fee0 = this.tokensOwed0;
    const fee1 = this.tokensOwed1;
    this.tokensOwed0 = 0n;
    this.tokensOwed1 = 0n;
    return { fee0, fee1 };
  }

  // increase unclaimed fees
  updateFees(fee0: bigint, fee1: bigint): void {
    this.tokensOwed0 += fee0;
    this.tokensOwed1 += fee1;
  }

  getTotals(sqrtPriceCurrent: bigint): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
    L: bigint;
  } {
    const { amount0, amount1 } =
      LiquidityCalculator.calculateAmountsForLiquidity(
        this.liquidity,
        sqrtPriceCurrent,
        LiquidityCalculator.tickToSqrtPriceX64(this.tickLower),
        LiquidityCalculator.tickToSqrtPriceX64(this.tickUpper)
      );
    return {
      amount0,
      amount1,
      fee0: this.tokensOwed0,
      fee1: this.tokensOwed1,
      L: this.liquidity,
    };
  }

  sqrtPricesX64(): {
    lower: bigint;
    upper: bigint;
  } {
    const lower = LiquidityCalculator.tickToSqrtPriceX64(this.tickLower);
    const upper = LiquidityCalculator.tickToSqrtPriceX64(this.tickUpper);
    return {
      lower,
      upper,
    };
  }

  setClosed(closed: boolean): void {
    this.isClosed = closed;
  }
}

export type VirtualPositionSimulateAction = "add" | "remove" | "collect";

export type ActionCost = {
  tokenA?: number;
  tokenB?: number;
  description?: string;
};

export class VirtualPositionManager {
  positions = new Map<string, VirtualPosition>();
  initialAmount0 = 0n;
  initialAmount1 = 0n;
  amount0 = 0n;
  amount1 = 0n;
  feeCollected0 = 0n;
  feeCollected1 = 0n;
  swapCost0 = 0n;
  swapCost1 = 0n;
  slippage0 = 0n;
  slippage1 = 0n;
  pool: Pool;
  positionIdCounter: number = 0;

  constructor(initialAmount0: bigint, initialAmount1: bigint, pool: Pool) {
    this.initialAmount0 = initialAmount0;
    this.initialAmount1 = initialAmount1;
    this.amount0 = initialAmount0;
    this.amount1 = initialAmount1;
    this.pool = pool;
  }

  getPosition(id: string): VirtualPosition | undefined {
    return this.positions.get(id);
  }

  newPositionId(): string {
    return `pos_${this.positionIdCounter++}`;
  }

  createPosition(
    id: string,
    tickLower: number,
    tickUpper: number,
    amount0: bigint,
    amount1: bigint,
    createdAt: number
  ): VirtualPosition {
    // Validate tick values before proceeding
    const MAX_TICK = LiquidityConstants.MAX_TICK; // Uniswap V3 max tick
    const MIN_TICK = LiquidityConstants.MIN_TICK; // Uniswap V3 min tick

    console.log(
      `[VirtualPositionManager] createPosition ${id} [${tickLower}, ${tickUpper}] amount0=${amount0} amount1=${amount1} balance0=${this.amount0} balance1=${this.amount1}`
    );

    const invalidTickRange =
      tickLower >= tickUpper || tickUpper < MIN_TICK || tickLower > MAX_TICK;
    if (invalidTickRange) {
      console.log(
        `[VPM] invalid tick range[${tickLower}, ${tickUpper}], [${MIN_TICK}, ${MAX_TICK}]`
      );
      throw new Error(
        `Invalid tick range[${tickLower}, ${tickUpper}], [${MIN_TICK}, ${MAX_TICK}]`
      );
    }

    let pos = this.positions.get(id);
    if (!pos) {
      pos = new VirtualPosition(id, tickLower, tickUpper, createdAt);
      this.positions.set(id, pos);
    }

    if (pos.liquidity > 0n) {
      console.log(`[VPM] position already exists ${id}`);
      throw new Error(`Position already exists ${id}`);
    }

    pos.tickLower = tickLower;
    pos.tickUpper = tickUpper;

    // reduct amount0 and amount1 from VPM balance first
    if (this.amount0 < amount0) {
      throw new Error(
        `Insufficient balance for token0: need ${amount0} (have ${this.amount0})`
      );
    }
    if (this.amount1 < amount1) {
      throw new Error(
        `Insufficient balance for token1: need ${amount1} (have ${this.amount1})`
      );
    }

    this.amount0 -= amount0;
    this.amount1 -= amount1;

    const result = LiquidityCalculator.maxLiquidity(
      this.pool.sqrtPriceX64,
      this.pool.feeRatePpm,
      tickLower,
      tickUpper,
      amount0,
      amount1,
      {
        name0: this.pool.token0Name,
        name1: this.pool.token1Name,
        decimals0: this.pool.decimals0,
        decimals1: this.pool.decimals1,
      }
    );

    pos.liquidity = result.liquidity;

    // Step 3: Add back actualRemain (physical balance left) to VPM balance
    // Note: We use actualRemain instead of remain because remain is an accounting
    // construct that can be negative to satisfy the invariant amount = usedAmount + remain
    this.amount0 += result.remain0;
    this.amount1 += result.remain1;

    // Track costs separately for reporting
    this.swapCost0 += result.swapCost0;
    this.swapCost1 += result.swapCost1;
    this.slippage0 += result.slippage0;
    this.slippage1 += result.slippage1;

    console.log(
      `[VirtualPositionManager] createPosition ${id} [${tickLower}, ${tickUpper}] liquidity=${
        result.liquidity
      } used0=${amount0 - result.remain0} used1=${amount1 - result.remain1}`
    );

    return pos;
  }

  calculatePositionAmounts(id: string): {
    amount0: bigint;
    amount1: bigint;
  } {
    const position = this.positions.get(id);
    if (!position) {
      throw new Error("Position not found");
    }
    return position.getTotals(this.pool.sqrtPriceX64);
  }

  calculatePositionFees(id: string): {
    fee0: bigint;
    fee1: bigint;
  } {
    const position = this.positions.get(id);
    if (!position) {
      throw new Error("Position not found");
    }
    return position.getTotals(this.pool.sqrtPriceX64);
  }

  // close all positions and update the manager's balances
  closeAllPositions(): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    const activePositions = Array.from(this.positions.values()).filter(
      (p) => !p.isClosed
    );

    // return summary data because balance updates are done in the closePosition method
    return activePositions.reduce(
      (acc, position) => {
        const result = position.close(this.pool.sqrtPriceX64);
        acc.amount0 += result.amount0;
        acc.amount1 += result.amount1;
        acc.fee0 += result.fee0;
        acc.fee1 += result.fee1;
        return acc;
      },
      { amount0: 0n, amount1: 0n, fee0: 0n, fee1: 0n }
    );
  }

  // close a position and update the manager's balances
  closePosition(
    id: string,
    currentTime: number
  ): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    const position = this.getPosition(id);
    if (!position) {
      throw new Error("Position not found");
    }
    const result = position.close(this.pool.sqrtPriceX64);
    this.amount0 += result.amount0 + result.fee0;
    this.amount1 += result.amount1 + result.fee1;
    this.feeCollected0 += result.fee0;
    this.feeCollected1 += result.fee1;
    position.setClosed(true);

    return result;
  }
  /**
   * Get all positions for snapshot tracking
   */
  getAllPositions(): VirtualPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get active positions (with liquidity > 0)
   */
  getActivePositions(): VirtualPosition[] {
    return Array.from(this.positions.values()).filter(
      (pos) => pos.liquidity > 0n
    );
  }

  /**
   * Get position count
   */
  getPositionCount(): number {
    return this.positions.size;
  }

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
    slippageTokenA: number;
    slippageTokenB: number;
  } {
    let amountA = this.amount0;
    let amountB = this.amount1;
    let feesOwed0 = 0n;
    let feesOwed1 = 0n;

    for (const position of this.positions.values()) {
      const { amount0, amount1, fee0, fee1 } = position.getTotals(
        this.pool.sqrtPriceX64
      );
      amountA += amount0;
      amountB += amount1;
      feesOwed0 += fee0;
      feesOwed1 += fee1;
    }

    return {
      amountA,
      amountB,
      feesOwed0,
      feesOwed1,
      positions: this.positions.size,
      initialAmountA: this.initialAmount0,
      initialAmountB: this.initialAmount1,
      cashAmountA: this.amount0,
      cashAmountB: this.amount1,
      collectedFees0: this.feeCollected0,
      collectedFees1: this.feeCollected1,
      totalCostTokenA: Number(this.swapCost0),
      totalCostTokenB: Number(this.swapCost1),
      slippageTokenA: Number(this.slippage0),
      slippageTokenB: Number(this.slippage1),
    };
  }

  collectAllPositionFees(): { fee0: bigint; fee1: bigint } {
    let totalFee0 = 0n;
    let totalFee1 = 0n;
    let positionsWithFees = 0;

    for (const pos of this.positions.values()) {
      const { fee0, fee1 } = pos.collectFees();
      if (fee0 > 0n || fee1 > 0n) {
        positionsWithFees++;
        console.log(
          `[VirtualPositionManager] Collected fees from position ${pos.id}: ` +
            `fee0=${fee0.toString()}, fee1=${fee1.toString()}`
        );
      }
      this.feeCollected0 += fee0;
      this.feeCollected1 += fee1;
      this.amount0 += fee0;
      this.amount1 += fee1;
      totalFee0 += fee0;
      totalFee1 += fee1;
    }

    console.log(
      `[VirtualPositionManager] Collected fees from ${positionsWithFees} positions: ` +
        `total fee0=${totalFee0.toString()}, total fee1=${totalFee1.toString()}, ` +
        `cumulative: fee0=${this.feeCollected0.toString()}, fee1=${this.feeCollected1.toString()}`
    );

    return { fee0: this.feeCollected0, fee1: this.feeCollected1 };
  }

  updateAllPositionFees(event: SwapEvent) {
    const sqrtPriceBefore = event.sqrtPriceBeforeX64;
    const sqrtPriceAfter = event.sqrtPriceAfterX64;
    const tickBefore = LiquidityCalculator.sqrtPriceToTick(sqrtPriceBefore);
    const tickAfter = LiquidityCalculator.sqrtPriceToTick(sqrtPriceAfter);
    const fee0 = event.zeroForOne ? event.fee : 0n;
    const fee1 = event.zeroForOne ? 0n : event.fee;

    // Find all positions that the swap crosses through
    const crossedPositions = this.findCrossedPositions(tickBefore, tickAfter);

    // Calculate total liquidity of our crossed positions
    const ourCrossedLiquidity = crossedPositions.reduce(
      (acc, position) => acc + position.liquidity,
      0n
    );

    // Use pool's actual liquidity (from real on-chain state)
    // This includes all LPs, not just our virtual positions
    const totalPoolLiquidity = this.pool.liquidity + ourCrossedLiquidity;
    console.log(
      `[VirtualPositionManager] updateAllPositionFees crossedPositions ${crossedPositions.length} ourCrossedLiquidity=${ourCrossedLiquidity} totalPoolLiquidity=${totalPoolLiquidity}`
    );

    // Calculate our share of the total pool
    const ourShareOfPool =
      totalPoolLiquidity > 0n
        ? Number((ourCrossedLiquidity * 10000n) / totalPoolLiquidity) / 100
        : 0;

    // Calculate fee distribution metrics
    const totalFees = fee0 + fee1;
    const feeRate =
      event.amountIn > 0n
        ? (Number(totalFees) / Number(event.amountIn)) * 100
        : 0;

    // Calculate our actual share of fees based on our liquidity proportion
    const ourFees0 =
      totalPoolLiquidity > 0n
        ? (fee0 * ourCrossedLiquidity) / totalPoolLiquidity
        : 0n;
    const ourFees1 =
      totalPoolLiquidity > 0n
        ? (fee1 * ourCrossedLiquidity) / totalPoolLiquidity
        : 0n;

    console.log(
      `[VirtualPositionManager] updateAllPositionFees ourFees0=${ourFees0} ourFees1=${ourFees1} ourCrossedLiquidity=${ourCrossedLiquidity} totalPoolLiquidity=${totalPoolLiquidity} fee0=${fee0} fee1=${fee1}`
    );

    // Distribute OUR fees (not total pool fees) among our positions
    this.distributeFees(
      crossedPositions,
      ourFees0,
      ourFees1,
      ourCrossedLiquidity
    );
  }

  private distributeFees(
    positions: VirtualPosition[],
    fee0: bigint,
    fee1: bigint,
    totalPoolLiquidity: bigint
  ) {
    if (positions.length === 0) return;

    let actualDistributedFee0 = 0n;
    let actualDistributedFee1 = 0n;

    // Distribute fees proportionally to each position
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i];
      if (position && totalPoolLiquidity > 0n) {
        const f0 = (fee0 * position.liquidity) / totalPoolLiquidity;
        const f1 = (fee1 * position.liquidity) / totalPoolLiquidity;
        console.log(
          `[VirtualPositionManager] distributeFees ${position.id} fee0=${f0} fee1=${f1} liquidity=${position.liquidity},total_fee0=${fee0} total_fee1=${fee1} pool_liquidity=${totalPoolLiquidity}`
        );
        position.updateFees(f0, f1);
        actualDistributedFee0 += f0;
        actualDistributedFee1 += f1;
      }
    }

    // Distribute remaining dust to the last position (handles rounding errors)
    // This ensures ALL fees are distributed, not lost to rounding
    const remainder0 = fee0 - actualDistributedFee0;
    const remainder1 = fee1 - actualDistributedFee1;

    if ((remainder0 > 0n || remainder1 > 0n) && positions.length > 0) {
      const lastPosition = positions[positions.length - 1];
      if (lastPosition) {
        lastPosition.updateFees(remainder0, remainder1);
        actualDistributedFee0 += remainder0;
        actualDistributedFee1 += remainder1;

        // Log dust distribution
        if (remainder0 > 0n || remainder1 > 0n) {
          console.log(
            `[VirtualPositionManager] distributeDustFees ${lastPosition.id} fee0=${remainder0} fee1=${remainder1}`
          );
        }
      }
    }

    // Verify all fees were distributed (should always be true now)
    if (actualDistributedFee0 !== fee0 || actualDistributedFee1 !== fee1) {
      console.warn(
        `[VirtualPositionManager] Fee distribution mismatch! ` +
          `Expected: fee0=${fee0}, fee1=${fee1}, ` +
          `Distributed: fee0=${actualDistributedFee0}, fee1=${actualDistributedFee1}`
      );
    }
  }

  /**
   * Find all positions that a swap crosses through when price moves from tickStart to tickEnd
   */
  private findCrossedPositions(
    tickStart: number,
    tickEnd: number
  ): VirtualPosition[] {
    const minTick = Math.min(tickStart, tickEnd);
    const maxTick = Math.max(tickStart, tickEnd);

    const crossedPositions: VirtualPosition[] = [];

    for (const position of this.positions.values()) {
      // A position is crossed if the swap path overlaps with the position's range
      // Position range: [tickLower, tickUpper]
      // Swap path: [minTick, maxTick]
      // Overlap exists if: max(tickLower, minTick) <= min(tickUpper, maxTick)
      const overlapStart = Math.max(position.tickLower, minTick);
      const overlapEnd = Math.min(position.tickUpper, maxTick);

      if (overlapStart <= overlapEnd && position.liquidity > 0n) {
        crossedPositions.push(position);
      }
    }

    return crossedPositions;
  }
}
