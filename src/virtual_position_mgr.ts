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
  positionIdCounter: number = 0;

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
    const MAX_TICK = 443636; // Uniswap V3 max tick
    const MIN_TICK = -443636; // Uniswap V3 min tick

    if (tickLower < MIN_TICK || tickLower > MAX_TICK) {
      throw new Error(
        `Invalid tickLower: ${tickLower} (must be between ${MIN_TICK} and ${MAX_TICK})`
      );
    }
    if (tickUpper < MIN_TICK || tickUpper > MAX_TICK) {
      throw new Error(
        `Invalid tickUpper: ${tickUpper} (must be between ${MIN_TICK} and ${MAX_TICK})`
      );
    }
    if (tickLower >= tickUpper) {
      throw new Error(
        `Invalid tick range: tickLower (${tickLower}) must be less than tickUpper (${tickUpper})`
      );
    }

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
      amount1
    );

    // Convert to human-readable for swap fee display
    const decimals0 = parseInt(process.env.TOKEN_A_DECIMALS || "6");
    const decimals1 = parseInt(process.env.TOKEN_B_DECIMALS || "6");

    // Log maxL input and output to show swap costs
    const input0Display = Number(amount0) / Math.pow(10, decimals0);
    const input1Display = Number(amount1) / Math.pow(10, decimals1);
    const deposited0Display =
      Number(result.depositedAmount0) / Math.pow(10, decimals0);
    const deposited1Display =
      Number(result.depositedAmount1) / Math.pow(10, decimals1);
    const swapFee0Display = Number(result.swapFee0) / Math.pow(10, decimals0);
    const swapFee1Display = Number(result.swapFee1) / Math.pow(10, decimals1);
    const slip0Display = Number(result.slip0) / Math.pow(10, decimals0);
    const slip1Display = Number(result.slip1) / Math.pow(10, decimals1);
    const remain0Display = Number(result.remain0) / Math.pow(10, decimals0);
    const remain1Display = Number(result.remain1) / Math.pow(10, decimals1);

    // Determine swap direction and show swap details
    let swapInfo = "";
    if (result.swapFee0 > 0n) {
      // Swapped token0 -> token1
      swapInfo = `Swap: ${process.env.TOKEN_A_NAME}→${process.env.TOKEN_B_NAME}`;
    } else if (result.swapFee1 > 0n) {
      // Swapped token1 -> token0
      swapInfo = `Swap: ${process.env.TOKEN_B_NAME}→${process.env.TOKEN_A_NAME}`;
    } else {
      swapInfo = "No swap";
    }

    console.log(
      `[maxLiquidity] Input: ${input0Display.toFixed(6)} ${
        process.env.TOKEN_A_NAME || "A"
      }, ${input1Display.toFixed(6)} ${process.env.TOKEN_B_NAME || "B"} | ` +
        `Deposited: ${deposited0Display.toFixed(6)} ${
          process.env.TOKEN_A_NAME || "A"
        }, ${deposited1Display.toFixed(6)} ${
          process.env.TOKEN_B_NAME || "B"
        } | ` +
        `Remain: ${remain0Display.toFixed(6)} ${
          process.env.TOKEN_A_NAME || "A"
        }, ${remain1Display.toFixed(6)} ${process.env.TOKEN_B_NAME || "B"}`
    );
    console.log(
      `               ${swapInfo} | ` +
        `Fee: ${swapFee0Display.toFixed(6)} ${
          process.env.TOKEN_A_NAME || "A"
        }, ${swapFee1Display.toFixed(6)} ${
          process.env.TOKEN_B_NAME || "B"
        } | ` +
        `Slip: ${slip0Display.toFixed(6)} ${
          process.env.TOKEN_A_NAME || "A"
        }, ${slip1Display.toFixed(6)} ${process.env.TOKEN_B_NAME || "B"}`
    );
    if (result.swapFee0 > 0n || result.swapFee1 > 0n) {
      const swapFee0Display = Number(result.swapFee0) / Math.pow(10, decimals0);
      const swapFee1Display = Number(result.swapFee1) / Math.pow(10, decimals1);
      console.log(
        `[createPosition] 💸 Swap fees paid: ${swapFee0Display.toFixed(6)} ${
          process.env.TOKEN_A_NAME || "A"
        }, ` +
          `${swapFee1Display.toFixed(6)} ${process.env.TOKEN_B_NAME || "B"}`
      );
    }

    pos.liquidity = result.liquidity;

    // Step 3: Add back actualRemain (physical balance left) to VPM balance
    // Note: We use actualRemain instead of remain because remain is an accounting
    // construct that can be negative to satisfy the invariant amount = usedAmount + remain
    this.amount0 = this.amount0 + result.actualRemain0;
    this.amount1 = this.amount1 + result.actualRemain1;

    // Track costs separately for reporting
    this.swapCost0 += result.swapFee0;
    this.swapCost1 += result.swapFee1;
    this.slippage0 += result.slip0;
    this.slippage1 += result.slip1;

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

  closeAllPositions(): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    let amount0 = 0n;
    let amount1 = 0n;
    let fee0 = 0n;
    let fee1 = 0n;

    for (const position of this.positions.values()) {
      const {
        amount0: posAmount0,
        amount1: posAmount1,
        fee0: posFee0,
        fee1: posFee1,
      } = position.close(this.pool.sqrtPriceX64);
      amount0 += posAmount0;
      amount1 += posAmount1;
      fee0 += posFee0;
      fee1 += posFee1;
    }

    // Add closed amounts to cash
    this.amount0 += amount0 + fee0;
    this.amount1 += amount1 + fee1;
    this.feeCollected0 += fee0;
    this.feeCollected1 += fee1;

    // Don't delete positions - keep them for historical tracking
    // Positions with liquidity=0 indicate they're closed

    return { amount0, amount1, fee0, fee1 };
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

    // Don't delete position - keep for historical tracking
    // Position with liquidity=0 indicates it's closed

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

    // Use pool's actual liquidity (from real on-chain state)
    // This includes all LPs, not just our virtual positions
    const totalPoolLiquidity = this.pool.liquidity;

    // Calculate our share of the total pool
    const ourShareOfPool =
      totalPoolLiquidity > 0n
        ? Number((ourCrossedLiquidity * 10000n) / totalPoolLiquidity) / 100
        : 0;

    console.log(
      `[VirtualPositionManager] Distributing fees from swap: ` +
        `direction=${event.zeroForOne ? "0→1" : "1→0"}, ` +
        `fee0=${fee0.toString()}, fee1=${fee1.toString()}, ` +
        `crossedPositions=${crossedPositions.length}`
    );
    console.log(
      `  Pool liquidity: ${totalPoolLiquidity.toString()}, ` +
        `Our liquidity: ${ourCrossedLiquidity.toString()}, ` +
        `Our share: ${ourShareOfPool.toFixed(6)}%`
    );
    console.log(
      `  Calculated activePoolLiq: ${activePoolLiquidity.toString()} ` +
        `(${
          totalPoolLiquidity > 0n
            ? Number((activePoolLiquidity * 10000n) / totalPoolLiquidity) / 100
            : 0
        }% of pool)`
    );
    console.log(
      `  Fee distribution: Total fee0=${fee0}, fee1=${fee1}, ` +
        `Our estimated share: fee0≈${(
          (Number(fee0) * ourShareOfPool) /
          100
        ).toFixed(2)}, ` +
        `fee1≈${((Number(fee1) * ourShareOfPool) / 100).toFixed(2)}`
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
