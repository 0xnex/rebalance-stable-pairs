import type { SwapEvent } from "./backtest_engine";
import type { MomentumEvent } from "./event_importer";
import { LiquidityCalculator } from "./liquidity_calculator";
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
}

export type VirtualPositionSimulateAction = "add" | "remove" | "collect";

export type ActionCost = {
  tokenA?: number;
  tokenB?: number;
  description?: string;
};

export interface PoolPositionContext {
  readonly tickCurrent: number;
  readonly price: number;
  readonly liquidity: bigint;
  readonly sqrtPriceX64: bigint;
  readonly ticks: Map<
    number,
    {
      liquidityNet: bigint;
      liquidityGross: bigint;
      feeGrowthOutside0X64: bigint;
      feeGrowthOutside1X64: bigint;
    }
  >;
  tickToSqrtPrice(tick: number): bigint;
  sqrtPriceToTick(sqrtPrice: bigint): number;
  calculateFeeGrowthInside(
    tickLower: number,
    tickUpper: number,
    tokenIndex: 0 | 1
  ): bigint;
  calculateLiquidityAmount(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): bigint;
  estimateAmountOut(
    amountIn: bigint,
    zeroForOne: boolean
  ): { amountOut: bigint; feeAmount: bigint; priceImpact: number };
}

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
  simulateErrors: number = 0;
  createPositionAttempts: number = 0;
  constructor(
    initialAmount0: bigint,
    initialAmount1: bigint,
    pool: Pool,
    simulateErrors?: number
  ) {
    this.initialAmount0 = initialAmount0;
    this.initialAmount1 = initialAmount1;
    this.amount0 = initialAmount0;
    this.amount1 = initialAmount1;
    this.pool = pool;
    this.simulateErrors = simulateErrors ?? 0;
  }

  getPosition(id: string): VirtualPosition | undefined {
    return this.positions.get(id);
  }

  createPosition(
    id: string,
    tickLower: number,
    tickUpper: number,
    amount0: bigint,
    amount1: bigint,
    createdAt: number
  ): VirtualPosition {
    // Increment attempt counter
    this.createPositionAttempts++;

    // Simulate error if configured (fail N-1 times, succeed on Nth attempt)
    if (this.simulateErrors > 0) {
      if (this.createPositionAttempts % this.simulateErrors !== 0) {
        console.log(
          `[VirtualPositionManager] Simulated error on createPosition attempt #${this.createPositionAttempts} ` +
            `(will succeed on attempt ${
              Math.ceil(this.createPositionAttempts / this.simulateErrors) *
              this.simulateErrors
            })`
        );
        throw new Error(
          `Simulated position creation error (attempt ${this.createPositionAttempts}/${this.simulateErrors})`
        );
      } else {
        console.log(
          `[VirtualPositionManager] Position creation succeeded on attempt #${this.createPositionAttempts}`
        );
      }
    }

    let pos = this.positions.get(id);
    if (!pos) {
      pos = new VirtualPosition(id, tickLower, tickUpper, createdAt);
      this.positions.set(id, pos);
    }

    if (pos.liquidity > 0n) {
      throw new Error("Position already exists");
    }

    pos.tickLower = tickLower;
    pos.tickUpper = tickUpper;

    const result = LiquidityCalculator.maxLiquidity(
      this.pool.sqrtPriceX64,
      this.pool.feeRatePpm,
      tickLower,
      tickUpper,
      amount0,
      amount1
    );

    const actualAmount0 = amount0 - result.remain0;
    const actualAmount1 = amount1 - result.remain1;

    if (this.amount0 < actualAmount0 || this.amount1 < actualAmount1) {
      throw new Error("Insufficient balance");
    }

    pos.liquidity = result.liquidity;
    this.amount0 = this.amount0 - amount0 + result.remain0;
    this.amount1 = this.amount1 - amount1 + result.remain1;
    this.swapCost0 += result.swapFee0;
    this.swapCost1 += result.swapFee1;
    this.slippage0 += result.slip0;
    this.slippage1 += result.slip1;
    return pos;
  }

  closePosition(id: string): {
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

    if (crossedPositions.length === 0) {
      console.log(
        `[VirtualPositionManager] No positions crossed by swap: ` +
          `tickBefore=${tickBefore}, tickAfter=${tickAfter}, totalPositions=${this.positions.size}`
      );
      return; // No positions to distribute fees to
    }

    // Calculate the active liquidity from the swap event
    const activePoolLiquidity =
      LiquidityCalculator.calculateActiveLiquidityFromSwap(
        sqrtPriceBefore,
        sqrtPriceAfter,
        event.amountIn - event.fee, // Assuming fee is deducted from amountIn
        event.amountOut,
        event.zeroForOne
      );

    // Calculate total liquidity of our crossed positions
    const ourCrossedLiquidity = crossedPositions.reduce(
      (acc, position) => acc + position.liquidity,
      0n
    );

    // Total pool liquidity ≈ Active Liquidity + Our Crossed Liquidity
    const totalPoolLiquidity = activePoolLiquidity + ourCrossedLiquidity;

    console.log(
      `[VirtualPositionManager] Distributing fees from swap: ` +
        `direction=${event.zeroForOne ? "0→1" : "1→0"}, ` +
        `fee0=${fee0.toString()}, fee1=${fee1.toString()}, ` +
        `crossedPositions=${crossedPositions.length}, ` +
        `activePoolLiq=${activePoolLiquidity.toString()}, ` +
        `ourLiq=${ourCrossedLiquidity.toString()}, ` +
        `totalLiq=${totalPoolLiquidity.toString()}, ` +
        `ourShare=${
          totalPoolLiquidity > 0n
            ? Number((ourCrossedLiquidity * 10000n) / totalPoolLiquidity) / 100
            : 0
        }%`
    );

    // Distribute fees proportionally
    this.distributeFees(crossedPositions, fee0, fee1, totalPoolLiquidity);
  }

  private distributeFees(
    positions: VirtualPosition[],
    fee0: bigint,
    fee1: bigint,
    totalPoolLiquidity: bigint
  ) {
    for (const position of positions) {
      if (totalPoolLiquidity > 0n) {
        const f0 = (fee0 * position.liquidity) / totalPoolLiquidity;
        const f1 = (fee1 * position.liquidity) / totalPoolLiquidity;
        position.updateFees(f0, f1);
      }
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

      if (overlapStart <= overlapEnd) {
        crossedPositions.push(position);
      }
    }

    return crossedPositions;
  }
}
