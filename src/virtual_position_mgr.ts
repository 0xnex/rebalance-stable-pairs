export type VirtualPosition = {
  id: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  feeGrowthInside0LastX64: bigint;
  feeGrowthInside1LastX64: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  createdAt: number;
};

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
  private positions = new Map<string, VirtualPosition>();
  private initialAmount0 = 0n;
  private initialAmount1 = 0n;
  private amount0 = 0n;
  private amount1 = 0n;
  private totalFeesCollected0 = 0n;
  private totalFeesCollected1 = 0n;
  private totalCostTokenA = 0;
  private totalCostTokenB = 0;

  // Virtual-only ticks (doesn't modify pool state)
  private virtualTicks = new Map<
    number,
    {
      liquidityNet: bigint;
      liquidityGross: bigint;
      feeGrowthOutside0X64: bigint;
      feeGrowthOutside1X64: bigint;
    }
  >();

  private lastProcessedTick: number | null = null;

  // Maximum ratio of virtual liquidity to pool liquidity (default 50%)
  // This ensures fee calculations remain accurate
  // For multi-position strategies (like 3-band), we need higher limits
  private maxLiquidityRatio = 0.5;

  private static readonly Q64 = 1n << 64n;

  constructor(private readonly pool: PoolPositionContext) {}

  /**
   * Subtract with modulo wrap-around for fee growth calculations
   * Handles the case where fee growth values wrap around 2^256
   */
  private submod(a: bigint, b: bigint): bigint {
    const diff = a - b;
    if (diff < 0n) {
      // Wrap around using 2^256 modulo (standard for Uniswap V3 fee growth)
      return diff + 2n ** 256n;
    }
    return diff;
  }

  setInitialBalances(amount0: bigint, amount1: bigint): void {
    this.initialAmount0 = amount0;
    this.initialAmount1 = amount1;
    this.amount0 = amount0;
    this.amount1 = amount1;
  }

  /**
   * Get total active liquidity from all virtual positions in current price range
   */
  private getTotalActiveLiquidity(): bigint {
    let total = 0n;
    const currentTick = this.pool.tickCurrent;

    for (const position of this.positions.values()) {
      // Check if position is in range
      if (
        currentTick >= position.tickLower &&
        currentTick < position.tickUpper
      ) {
        total += position.liquidity;
      }
    }

    return total;
  }

  /**
   * Update virtual ticks when price crosses them
   * This is critical for correct fee calculations
   */
  private processTickCrossings(): void {
    const currentTick = this.pool.tickCurrent;

    if (this.lastProcessedTick === null) {
      this.lastProcessedTick = currentTick;
      return;
    }

    if (currentTick === this.lastProcessedTick) {
      return; // No crossing
    }

    const global0 = (this.pool as any).feeGrowthGlobal0X64 || 0n;
    const global1 = (this.pool as any).feeGrowthGlobal1X64 || 0n;

    // Determine direction and range of ticks crossed
    const movingUp = currentTick > this.lastProcessedTick;
    const startTick = movingUp ? this.lastProcessedTick : currentTick;
    const endTick = movingUp ? currentTick : this.lastProcessedTick;

    // Update all virtual ticks that were crossed
    for (const [tick, tickData] of this.virtualTicks.entries()) {
      if (tick > startTick && tick <= endTick) {
        // This tick was crossed
        // When crossing a tick, feeGrowthOutside is updated to: global - feeGrowthOutside
        tickData.feeGrowthOutside0X64 = global0 - tickData.feeGrowthOutside0X64;
        tickData.feeGrowthOutside1X64 = global1 - tickData.feeGrowthOutside1X64;
      }
    }

    this.lastProcessedTick = currentTick;
  }

  /**
   * Calculate total fees for a position using monotonic, non-negative deltas.
   * Ensures we never return negative fees due to wrapped or decreasing checkpoints.
   */
  private calculatePositionFees(positionId: string): {
    fee0: bigint;
    fee1: bigint;
  } {
    const position = this.positions.get(positionId);
    if (!position) {
      return { fee0: 0n, fee1: 0n };
    }

    // Keep virtual tick feeGrowthOutside in sync on tick moves
    this.processTickCrossings();

    // Compute feeGrowthInside using pool (preferred) with fallback to virtual ticks
    const feeInside0 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      0
    );
    const feeInside1 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      1
    );

    // Deltas since last checkpoint; clamp to >= 0 to avoid negative due to wrap or reorder
    let delta0 = feeInside0 - position.feeGrowthInside0LastX64;
    let delta1 = feeInside1 - position.feeGrowthInside1LastX64;
    if (delta0 < 0n) delta0 = 0n;
    if (delta1 < 0n) delta1 = 0n;

    // Newly accrued fees
    const newFee0 = (position.liquidity * delta0) / 2n ** 64n;
    const newFee1 = (position.liquidity * delta1) / 2n ** 64n;

    // Total owed = already owed + newly accrued; never negative
    let total0 = position.tokensOwed0 + newFee0;
    let total1 = position.tokensOwed1 + newFee1;
    if (total0 < 0n) total0 = 0n;
    if (total1 < 0n) total1 = 0n;

    return { fee0: total0, fee1: total1 };
  }

  /**
   * Get tick data for virtual position fee calculations
   * NEVER use real pool ticks because they may have wrapped values from submod
   * Always use virtual ticks initialized specifically for this position
   */
  private getTickData(tick: number):
    | {
        liquidityNet: bigint;
        liquidityGross: bigint;
        feeGrowthOutside0X64: bigint;
        feeGrowthOutside1X64: bigint;
      }
    | undefined {
    // Only use virtual ticks - pool ticks have wrapped values
    return this.virtualTicks.get(tick);
  }

  /**
   * Calculate fee growth inside a position range
   * Works with both pool ticks and virtual ticks without modifying pool state
   */
  private calculateFeeGrowthInside(
    tickLower: number,
    tickUpper: number,
    tokenIndex: 0 | 1
  ): bigint {
    // ALWAYS use virtual ticks for consistency
    // Virtual positions need isolated fee tracking separate from real pool
    const tickLowerData = this.getTickData(tickLower);
    const tickUpperData = this.getTickData(tickUpper);

    if (!tickLowerData || !tickUpperData) {
      // SAFER: Don't assume all global fees apply, return 0 instead
      // This prevents massive fee spikes when tick data is missing
      return 0n;
    }

    const globalFeeGrowth =
      tokenIndex === 0
        ? (this.pool as any).feeGrowthGlobal0X64 || 0n
        : (this.pool as any).feeGrowthGlobal1X64 || 0n;

    const feeGrowthOutsideLower =
      tokenIndex === 0
        ? tickLowerData.feeGrowthOutside0X64
        : tickLowerData.feeGrowthOutside1X64;
    const feeGrowthOutsideUpper =
      tokenIndex === 0
        ? tickUpperData.feeGrowthOutside0X64
        : tickUpperData.feeGrowthOutside1X64;

    // Calculate fee growth inside the range
    // For virtual positions, we use simple subtraction and clamp to 0 if negative
    // This prevents massive wrapped values from being used as initial checkpoints
    let feeGrowthInside: bigint;
    if (this.pool.tickCurrent < tickLower) {
      // Current price below range
      const result = feeGrowthOutsideLower - feeGrowthOutsideUpper;
      feeGrowthInside = result < 0n ? 0n : result;
    } else if (this.pool.tickCurrent >= tickUpper) {
      // Current price above range
      const result = feeGrowthOutsideUpper - feeGrowthOutsideLower;
      feeGrowthInside = result < 0n ? 0n : result;
    } else {
      // Current price inside range
      const temp = globalFeeGrowth - feeGrowthOutsideLower;
      const result = temp < 0n ? 0n : temp - feeGrowthOutsideUpper;
      feeGrowthInside = result < 0n ? 0n : result;

      // Debug extreme values
      if (feeGrowthInside > 1000000000000000000n) {
        console.warn(`[VPM calculateFeeGrowthInside] HUGE value detected:`);
        console.warn(
          `  tickRange: [${tickLower}, ${tickUpper}], currentTick: ${this.pool.tickCurrent}`
        );
        console.warn(`  global: ${globalFeeGrowth}`);
        console.warn(`  fo[lower]: ${feeGrowthOutsideLower}`);
        console.warn(`  fo[upper]: ${feeGrowthOutsideUpper}`);
        console.warn(`  temp: ${temp}`);
        console.warn(`  result: ${result}`);
        console.warn(`  feeGrowthInside: ${feeGrowthInside}`);
      }
    }

    return feeGrowthInside;
  }

  /**
   * Dry-run helpers -----------------------------------------------------------------
   */

  estimateCreatePosition(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): {
    liquidity: bigint;
    requiredAmountA: bigint;
    requiredAmountB: bigint;
    unusedAmountA: bigint;
    unusedAmountB: bigint;
  } {
    const funding = this.computePositionFunding(
      tickLower,
      tickUpper,
      amountA,
      amountB
    );

    return {
      liquidity: funding.liquidity,
      requiredAmountA: funding.usedA,
      requiredAmountB: funding.usedB,
      unusedAmountA: funding.refundA,
      unusedAmountB: funding.refundB,
    };
  }

  estimatePositionValue(positionId: string) {
    return this.getPositionValue(positionId);
  }

  estimateAddToPosition(positionId: string, amountA: bigint, amountB: bigint) {
    const position = this.positions.get(positionId);
    if (!position) return null;

    const nextAmountA = position.amount0 + amountA;
    const nextAmountB = position.amount1 + amountB;
    const nextLiquidity = this.calculateVirtualLiquidity(
      position.tickLower,
      position.tickUpper,
      nextAmountA,
      nextAmountB
    );

    return {
      amountA: nextAmountA,
      amountB: nextAmountB,
      liquidity: nextLiquidity,
    };
  }

  estimateRemoveFromPosition(
    positionId: string,
    amountA: bigint,
    amountB: bigint
  ) {
    const position = this.positions.get(positionId);
    if (!position) return null;

    if (amountA > position.amount0 || amountB > position.amount1) {
      return null;
    }

    const nextAmountA = position.amount0 - amountA;
    const nextAmountB = position.amount1 - amountB;
    const nextLiquidity = this.calculateVirtualLiquidity(
      position.tickLower,
      position.tickUpper,
      nextAmountA,
      nextAmountB
    );

    return {
      amountA: nextAmountA,
      amountB: nextAmountB,
      liquidity: nextLiquidity,
    };
  }

  estimateCollectableFees(positionId: string) {
    return this.calculatePositionFees(positionId);
  }

  openPosition(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint,
    actionCost?: ActionCost
  ): {
    positionId: string;
    liquidity: bigint;
    usedTokenA: bigint;
    usedTokenB: bigint;
    returnTokenA: bigint;
    returnTokenB: bigint;
    slippage: number;
    gasFee: bigint;
  } {
    if (amountA < 0n || amountB < 0n) {
      throw new Error("Amounts must be non-negative");
    }

    const funding = this.computePositionFunding(
      tickLower,
      tickUpper,
      amountA,
      amountB
    );

    const { liquidity, usedA, usedB, refundA, refundB } = funding;

    if (usedA > this.amount0 || usedB > this.amount1) {
      throw new Error("Insufficient available balances to open position");
    }

    if (liquidity <= 0n && (usedA > 0n || usedB > 0n)) {
      throw new Error("Unable to derive liquidity from provided amounts");
    }

    const positionId = this.createPosition(tickLower, tickUpper, usedA, usedB);

    this.applyActionCost(actionCost);

    return {
      positionId,
      liquidity,
      usedTokenA: usedA,
      usedTokenB: usedB,
      returnTokenA: refundA,
      returnTokenB: refundB,
      slippage: 0,
      gasFee: 0n,
    };
  }

  addLiquidityWithSwap(
    tickLower: number,
    tickUpper: number,
    maxAmountA: bigint,
    maxAmountB: bigint,
    maxSlippageBps: number,
    actionCost?: ActionCost
  ): {
    positionId: string;
    liquidity: bigint;
    usedTokenA: bigint;
    usedTokenB: bigint;
    returnTokenA: bigint;
    returnTokenB: bigint;
    swappedFromTokenA: bigint;
    swappedFromTokenB: bigint;
    swappedToTokenA: bigint;
    swappedToTokenB: bigint;
    remainingTokenA: bigint;
    remainingTokenB: bigint;
    slippageHit: boolean;
  } {
    const snapshotCashA = this.amount0;
    const snapshotCashB = this.amount1;
    try {
      if (maxAmountA < 0n || maxAmountB < 0n) {
        throw new Error("Amounts must be non-negative");
      }

      if (maxSlippageBps < 0) {
        throw new Error("maxSlippageBps must be >= 0");
      }

      if (this.amount0 <= 0n && this.amount1 <= 0n) {
        throw new Error("No available balances to add liquidity");
      }

      const availableA = maxAmountA <= this.amount0 ? maxAmountA : this.amount0;
      const availableB = maxAmountB <= this.amount1 ? maxAmountB : this.amount1;

      if (availableA <= 0n && availableB <= 0n) {
        throw new Error("Provided limits are zero");
      }

      let workingA = availableA;
      let workingB = availableB;
      let swappedFromA = 0n;
      let swappedFromB = 0n;
      let swappedToA = 0n;
      let swappedToB = 0n;
      let slippageHit = false;

      const sqrtLower = this.pool.tickToSqrtPrice(tickLower);
      const sqrtUpper = this.pool.tickToSqrtPrice(tickUpper);
      const sqrtCurrent = this.pool.sqrtPriceX64;

      const inRange =
        this.pool.tickCurrent >= tickLower && this.pool.tickCurrent < tickUpper;

      const trySwap = (
        amountNeeded: bigint,
        maxAvailable: bigint,
        zeroForOne: boolean
      ) => {
        if (maxAvailable <= 0n) return { usedIn: 0n, out: 0n, hit: false };

        const result = this.findSwapAmount(
          amountNeeded,
          maxAvailable,
          zeroForOne,
          maxSlippageBps
        );

        if (!result) {
          slippageHit = slippageHit || amountNeeded > 0n;
          return { usedIn: 0n, out: 0n, hit: amountNeeded > 0n };
        }

        if (result.amountIn <= 0n || result.amountOut <= 0n) {
          slippageHit = slippageHit || amountNeeded > 0n;
          return { usedIn: 0n, out: 0n, hit: amountNeeded > 0n };
        }

        if (result.slippageExceeded) {
          slippageHit = true;
        }

        if (zeroForOne) {
          // swapping token0 -> token1 (A -> B)
          this.amount0 -= result.amountIn;
          this.amount1 += result.amountOut;
          swappedFromA += result.amountIn;
          swappedToB += result.amountOut;
          workingA -= result.amountIn;
          workingB += result.amountOut;
        } else {
          // swapping token1 -> token0 (B -> A)
          this.amount1 -= result.amountIn;
          this.amount0 += result.amountOut;
          swappedFromB += result.amountIn;
          swappedToA += result.amountOut;
          workingB -= result.amountIn;
          workingA += result.amountOut;
        }

        return {
          usedIn: result.amountIn,
          out: result.amountOut,
          hit: !!result.slippageExceeded,
        };
      };

      if (workingA === 0n && workingB > 0n) {
        const swapBudget = workingB / 2n;
        if (swapBudget > 0n) {
          trySwap(0n, swapBudget, false);
        }
      } else if (workingB === 0n && workingA > 0n) {
        const swapBudget = workingA / 2n;
        if (swapBudget > 0n) {
          trySwap(0n, swapBudget, true);
        }
      }

      const initialFunding = this.computePositionFunding(
        tickLower,
        tickUpper,
        workingA,
        workingB
      );

      const updateFundingAfterSwap = () =>
        this.computePositionFunding(tickLower, tickUpper, workingA, workingB);

      let funding = initialFunding;

      if (funding.liquidity <= 0n) {
        if (this.pool.tickCurrent < tickLower && workingB > 0n) {
          const swapResult = trySwap(0n, workingB, false);
          if (swapResult.usedIn > 0n) {
            funding = updateFundingAfterSwap();
          }
        } else if (this.pool.tickCurrent >= tickUpper && workingA > 0n) {
          const swapResult = trySwap(0n, workingA, true);
          if (swapResult.usedIn > 0n) {
            funding = updateFundingAfterSwap();
          }
        }
      }

      if (funding.liquidity > 0n) {
        const extraA = workingA - funding.usedA;
        const extraB = workingB - funding.usedB;

        if (extraB > 0n) {
          if (inRange) {
            const liquidityUsingAllB = this.liquidityForAmount1(
              workingB,
              sqrtLower,
              sqrtCurrent
            );
            const neededAForAllB = this.amount0ForLiquidity(
              liquidityUsingAllB,
              sqrtCurrent,
              sqrtUpper
            );
            if (neededAForAllB > workingA) {
              const additionalA = neededAForAllB - workingA;
              const swapResult = trySwap(additionalA, extraB, false);
              if (swapResult.usedIn > 0n) {
                funding = updateFundingAfterSwap();
              }
            }
          } else if (this.pool.tickCurrent < tickLower) {
            const swapResult = trySwap(0n, extraB, false);
            if (swapResult.usedIn > 0n) {
              funding = updateFundingAfterSwap();
            }
          }
        }

        const updatedExtraA = workingA - funding.usedA;
        if (updatedExtraA > 0n) {
          if (inRange) {
            const liquidityUsingAllA = this.liquidityForAmount0(
              workingA,
              sqrtCurrent,
              sqrtUpper
            );
            const neededBForAllA = this.amount1ForLiquidity(
              liquidityUsingAllA,
              sqrtLower,
              sqrtCurrent
            );
            if (neededBForAllA > workingB) {
              const additionalB = neededBForAllA - workingB;
              const swapResult = trySwap(additionalB, updatedExtraA, true);
              if (swapResult.usedIn > 0n) {
                funding = updateFundingAfterSwap();
              }
            }
          } else if (this.pool.tickCurrent >= tickUpper) {
            const swapResult = trySwap(0n, updatedExtraA, true);
            if (swapResult.usedIn > 0n) {
              funding = updateFundingAfterSwap();
            }
          }
        }
      }

      if (funding.liquidity <= 0n) {
        throw new Error("Unable to derive liquidity from provided amounts");
      }

      if (funding.usedA > this.amount0 || funding.usedB > this.amount1) {
        throw new Error("Insufficient balances after swaps to open position");
      }

      const positionId = this.createPosition(
        tickLower,
        tickUpper,
        funding.usedA,
        funding.usedB
      );

      return {
        positionId,
        liquidity: funding.liquidity,
        usedTokenA: funding.usedA,
        usedTokenB: funding.usedB,
        returnTokenA: funding.refundA,
        returnTokenB: funding.refundB,
        swappedFromTokenA: swappedFromA,
        swappedFromTokenB: swappedFromB,
        swappedToTokenA: swappedToA,
        swappedToTokenB: swappedToB,
        remainingTokenA: this.amount0,
        remainingTokenB: this.amount1,
        slippageHit,
      };
    } catch (error) {
      this.amount0 = snapshotCashA;
      this.amount1 = snapshotCashB;
      throw error;
    }
  }

  estimateMaxSwapWithSlippage(
    positionId: string,
    zeroForOne: boolean,
    slippageBps: number,
    precision: number = 20
  ) {
    const position = this.positions.get(positionId);
    if (!position) {
      return {
        amountIn: 0n,
        amountOut: 0n,
        priceImpact: 0,
        slippageHit: false,
      };
    }

    const available = zeroForOne ? position.amount0 : position.amount1;
    if (available <= 0n) {
      return {
        amountIn: 0n,
        amountOut: 0n,
        priceImpact: 0,
        slippageHit: false,
      };
    }

    const targetImpact = slippageBps / 100; // convert bps → percent
    let low = 0n;
    let high = available;
    let bestIn = 0n;
    let bestOut = 0n;
    let bestImpact = 0;

    for (let i = 0; i < precision && low <= high; i++) {
      const mid = (low + high) / 2n;
      if (mid === 0n) {
        low = mid + 1n;
        continue;
      }

      const { amountOut, priceImpact } = this.pool.estimateAmountOut(
        mid,
        zeroForOne
      );

      if (priceImpact <= targetImpact) {
        bestIn = mid;
        bestOut = amountOut;
        bestImpact = priceImpact;
        low = mid + 1n;
      } else {
        high = mid - 1n;
      }
    }

    return {
      amountIn: bestIn,
      amountOut: bestOut,
      priceImpact: bestImpact,
      slippageHit: bestImpact >= targetImpact,
    };
  }

  createPosition(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint,
    positionId?: string
  ): string {
    const id =
      positionId ||
      `pos_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Check if we have enough balance
    if (amountA > this.amount0 || amountB > this.amount1) {
      throw new Error(
        `Insufficient balance: need ${amountA} tokenA, ${amountB} tokenB, have ${this.amount0} tokenA, ${this.amount1} tokenB`
      );
    }

    const liquidity = this.calculateVirtualLiquidity(
      tickLower,
      tickUpper,
      amountA,
      amountB
    );

    // CRITICAL: Validate that total virtual liquidity doesn't exceed pool liquidity ratio
    // VPM uses pool's feeGrowthGlobal which is calculated as: fee / pool.liquidity
    // If total virtual liquidity is too large, fee calculations become incorrect
    const poolLiquidity = this.pool.liquidity;
    const currentActiveLiquidity = this.getTotalActiveLiquidity();
    const totalAfterCreation = currentActiveLiquidity + liquidity;
    const maxAllowed =
      (poolLiquidity * BigInt(Math.floor(this.maxLiquidityRatio * 1000))) /
      1000n;

    if (totalAfterCreation > maxAllowed) {
      const ratio = (
        (Number(totalAfterCreation) / Number(poolLiquidity)) *
        100
      ).toFixed(2);
      throw new Error(
        `Cannot create position: total virtual liquidity (${totalAfterCreation.toString()}) ` +
          `would exceed ${(this.maxLiquidityRatio * 100).toFixed(
            0
          )}% of pool liquidity (${poolLiquidity.toString()}). ` +
          `This would be ${ratio}% of pool. Current virtual: ${currentActiveLiquidity.toString()}, ` +
          `new position: ${liquidity.toString()}.`
      );
    }

    // Also warn if single position is very large (even if total is ok)
    if (liquidity > poolLiquidity / 10n) {
      console.warn(
        `⚠️  Warning: Single position liquidity (${liquidity.toString()}) is >10% of pool liquidity (${poolLiquidity.toString()}). ` +
          `Consider splitting into smaller positions for more accurate fee tracking.`
      );
    }

    // Ensure tick data exists for the position range
    // Initialize virtual tick data (doesn't modify pool state)
    // Only create virtual ticks if they don't exist in the pool
    // IMPORTANT: Initialize feeGrowthOutside correctly based on current tick position
    // Per Uniswap V3: if tick <= current, feeGrowthOutside = global; else 0
    const currentTick = this.pool.tickCurrent;
    const global0 = (this.pool as any).feeGrowthGlobal0X64 || 0n;
    const global1 = (this.pool as any).feeGrowthGlobal1X64 || 0n;

    // CRITICAL: Always create/update virtual ticks for virtual positions
    // Even if real pool ticks exist, virtual positions need their own feeGrowthOutside
    // values initialized according to Uniswap V3 spec (based on current tick)
    if (!this.virtualTicks.has(tickLower)) {
      this.virtualTicks.set(tickLower, {
        liquidityNet: 0n,
        liquidityGross: 0n,
        feeGrowthOutside0X64: tickLower <= currentTick ? global0 : 0n,
        feeGrowthOutside1X64: tickLower <= currentTick ? global1 : 0n,
      });
    }
    if (!this.virtualTicks.has(tickUpper)) {
      this.virtualTicks.set(tickUpper, {
        liquidityNet: 0n,
        liquidityGross: 0n,
        feeGrowthOutside0X64: tickUpper <= currentTick ? global0 : 0n,
        feeGrowthOutside1X64: tickUpper <= currentTick ? global1 : 0n,
      });
    }

    // Debug: Check tick data BEFORE calculating feeGrowthInside
    const tickLowerDataBefore = this.getTickData(tickLower);
    const tickUpperDataBefore = this.getTickData(tickUpper);

    console.log(
      `[VirtualPositionManager] Tick data AFTER initialization for ${id}:`,
      {
        tickLower: {
          tick: tickLower,
          exists: !!tickLowerDataBefore,
          fo0: tickLowerDataBefore?.feeGrowthOutside0X64?.toString() || "N/A",
          fo1: tickLowerDataBefore?.feeGrowthOutside1X64?.toString() || "N/A",
        },
        tickUpper: {
          tick: tickUpper,
          exists: !!tickUpperDataBefore,
          fo0: tickUpperDataBefore?.feeGrowthOutside0X64?.toString() || "N/A",
          fo1: tickUpperDataBefore?.feeGrowthOutside1X64?.toString() || "N/A",
        },
        currentTick: this.pool.tickCurrent,
        global0: global0.toString(),
        global1: global1.toString(),
      }
    );

    // Initialize fee growth checkpoints using virtual position manager's calculation
    // This ensures fees start accumulating correctly from creation using virtual tick data
    const feeGrowthInside0 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      0
    );
    const feeGrowthInside1 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      1
    );

    const position: VirtualPosition = {
      id,
      tickLower,
      tickUpper,
      liquidity,
      amount0: amountA,
      amount1: amountB,
      feeGrowthInside0LastX64: feeGrowthInside0,
      feeGrowthInside1LastX64: feeGrowthInside1,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
      createdAt: Date.now(),
    };

    // Deduct the amounts from initial balance
    this.amount0 -= amountA;
    this.amount1 -= amountB;

    this.positions.set(id, position);
    return id;
  }

  updatePosition(
    positionId: string,
    amountADelta: bigint,
    amountBDelta: bigint
  ): boolean {
    const position = this.positions.get(positionId);
    if (!position) return false;

    position.amount0 += amountADelta;
    position.amount1 += amountBDelta;
    if (position.amount0 < 0n || position.amount1 < 0n) {
      position.amount0 -= amountADelta;
      position.amount1 -= amountBDelta;
      return false;
    }
    position.liquidity = this.calculateVirtualLiquidity(
      position.tickLower,
      position.tickUpper,
      position.amount0,
      position.amount1
    );
    return true;
  }

  removePosition(positionId: string, actionCost?: ActionCost): boolean {
    const position = this.positions.get(positionId);
    if (!position) {
      return false;
    }

    // Snapshot fees before closing the position
    this.updatePositionFees(positionId);

    const tokensOwed0 = position.tokensOwed0;
    const tokensOwed1 = position.tokensOwed1;

    // Return principal and accrued fees to cash balances
    this.amount0 += position.amount0 + tokensOwed0;
    this.amount1 += position.amount1 + tokensOwed1;
    this.totalFeesCollected0 += tokensOwed0;
    this.totalFeesCollected1 += tokensOwed1;

    this.applyActionCost(actionCost);

    return this.positions.delete(positionId);
  }

  getPosition(positionId: string): VirtualPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Calculate current token amounts for a position based on current price
   * Returns the actual amounts of token A and B currently in the position
   */
  calculatePositionAmounts(positionId: string): {
    currentAmountA: bigint;
    currentAmountB: bigint;
  } {
    const position = this.positions.get(positionId);
    if (!position) {
      return { currentAmountA: 0n, currentAmountB: 0n };
    }

    // Keep virtual tick feeGrowthOutside in sync when price crosses ticks
    this.processTickCrossings();

    const currentTick = this.pool.tickCurrent;
    const sqrtPriceX64 = this.pool.sqrtPriceX64;
    const Q64 = VirtualPositionManager.Q64;

    // Get sqrt prices for position boundaries
    const sqrtLower = this.pool.tickToSqrtPrice(position.tickLower);
    const sqrtUpper = this.pool.tickToSqrtPrice(position.tickUpper);

    let amount0 = 0n;
    let amount1 = 0n;

    if (
      position.liquidity > 0n &&
      sqrtLower > 0n &&
      sqrtUpper > 0n &&
      sqrtPriceX64 > 0n
    ) {
      try {
        if (currentTick < position.tickLower) {
          // Position is above current price - all token0 (tokenA)
          // Safe division to prevent overflow
          if (sqrtLower > 0n && sqrtUpper > 0n) {
            amount0 =
              (position.liquidity * Q64 * (sqrtUpper - sqrtLower)) /
              sqrtLower /
              sqrtUpper;
          }
          amount1 = 0n;
        } else if (currentTick >= position.tickUpper) {
          // Position is below current price - all token1 (tokenB)
          amount0 = 0n;
          amount1 = (position.liquidity * (sqrtUpper - sqrtLower)) / Q64;
        } else {
          // Position is in range - mix of both tokens
          if (sqrtPriceX64 > 0n && sqrtUpper > 0n) {
            amount0 =
              (position.liquidity * Q64 * (sqrtUpper - sqrtPriceX64)) /
              sqrtPriceX64 /
              sqrtUpper;
          }
          amount1 = (position.liquidity * (sqrtPriceX64 - sqrtLower)) / Q64;
        }

        // Sanity check: cap amounts to prevent unrealistic spikes
        // Use realistic DeFi limits instead of astronomical 2^96
        const MAX_REASONABLE_AMOUNT = 1000000000000000000n; // 1e18 (1 ETH in wei, reasonable for most tokens)

        if (
          amount0 > MAX_REASONABLE_AMOUNT ||
          amount1 > MAX_REASONABLE_AMOUNT
        ) {
          // Log the problematic calculation for debugging
          console.warn(
            `[VirtualPositionManager] Calculated amount too large: amount0=${amount0} amount1=${amount1} liquidity=${position.liquidity} tick=${currentTick} range=[${position.tickLower},${position.tickUpper}]`
          );
          amount0 = position.amount0;
          amount1 = position.amount1;
        }
      } catch (error) {
        // Fallback to stored amounts if calculation fails
        amount0 = position.amount0;
        amount1 = position.amount1;
      }
    }

    return {
      currentAmountA: amount0,
      currentAmountB: amount1,
    };
  }

  /**
   * Calculate newly accrued fees since last update (for internal use by updatePositionFees)
   */
  private calculateNewPositionFees(positionId: string): {
    fee0: bigint;
    fee1: bigint;
  } {
    const position = this.positions.get(positionId);
    if (!position) return { fee0: 0n, fee1: 0n };

    // Check if position is in range
    const inRange =
      this.pool.tickCurrent >= position.tickLower &&
      this.pool.tickCurrent < position.tickUpper;

    if (!inRange) {
      // Out of range: return stored fees (fees don't accumulate when out of range)
      return {
        fee0: position.tokensOwed0,
        fee1: position.tokensOwed1,
      };
    }

    // In range: Use virtual position manager's fee calculation for consistency
    // This ensures fees are calculated using virtual tick data
    const feeGrowthInside0 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      0
    );
    const feeGrowthInside1 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      1
    );

    // Calculate fee delta since position was created (clamp negative to 0)
    const rawDelta0 = feeGrowthInside0 - position.feeGrowthInside0LastX64;
    const rawDelta1 = feeGrowthInside1 - position.feeGrowthInside1LastX64;
    const delta0 = rawDelta0 < 0n ? 0n : rawDelta0;
    const delta1 = rawDelta1 < 0n ? 0n : rawDelta1;

    // Calculate fees earned from the delta (this is the total fees since creation)
    const fee0 = (position.liquidity * delta0) / 2n ** 64n;
    const fee1 = (position.liquidity * delta1) / 2n ** 64n;

    return {
      fee0,
      fee1,
    };
  }

  updatePositionFees(positionId: string): boolean {
    const position = this.positions.get(positionId);
    if (!position) return false;

    // Sync tick crossings before reading fee growth
    this.processTickCrossings();

    // Check if position is in range
    const inRange =
      this.pool.tickCurrent >= position.tickLower &&
      this.pool.tickCurrent < position.tickUpper;

    if (!inRange) {
      // Out of range: fees don't accumulate
      return true;
    }

    // Use virtual position manager's fee growth calculation for consistency
    // This ensures fees accumulate correctly using virtual tick data
    const feeGrowthInside0 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      0
    );
    const feeGrowthInside1 = this.calculateFeeGrowthInside(
      position.tickLower,
      position.tickUpper,
      1
    );

    // Calculate fee delta since last update (clamp negative to 0)
    const rawDelta0 = feeGrowthInside0 - position.feeGrowthInside0LastX64;
    const rawDelta1 = feeGrowthInside1 - position.feeGrowthInside1LastX64;
    const delta0 = rawDelta0 < 0n ? 0n : rawDelta0;
    const delta1 = rawDelta1 < 0n ? 0n : rawDelta1;

    // Calculate new fees from the delta
    const newFees0 = (position.liquidity * delta0) / 2n ** 64n;
    const newFees1 = (position.liquidity * delta1) / 2n ** 64n;

    // ACCUMULATE fees (don't replace)
    position.tokensOwed0 += newFees0;
    position.tokensOwed1 += newFees1;
    if (position.tokensOwed0 < 0n) position.tokensOwed0 = 0n;
    if (position.tokensOwed1 < 0n) position.tokensOwed1 = 0n;

    // Update checkpoints
    position.feeGrowthInside0LastX64 = feeGrowthInside0;
    position.feeGrowthInside1LastX64 = feeGrowthInside1;

    return true;
  }

  updateAllPositionFees(): void {
    // Process tick crossings first to update virtual tick states
    this.processTickCrossings();

    for (const id of this.positions.keys()) {
      this.updatePositionFees(id);
    }
  }

  getPositionValue(positionId: string): {
    totalValue: bigint;
    valueA: bigint;
    valueB: bigint;
    fees: { fee0: bigint; fee1: bigint };
  } {
    const position = this.positions.get(positionId);
    if (!position) {
      return {
        totalValue: 0n,
        valueA: 0n,
        valueB: 0n,
        fees: { fee0: 0n, fee1: 0n },
      };
    }

    const fees = this.calculatePositionFees(positionId);
    const valueA = position.amount0;
    const valueB = position.amount1;
    const totalValue = valueA + valueB;

    return { totalValue, valueA, valueB, fees };
  }

  simulatePositionAction(
    action: VirtualPositionSimulateAction,
    positionId: string,
    amountA?: bigint,
    amountB?: bigint
  ): {
    success: boolean;
    newAmountA?: bigint;
    newAmountB?: bigint;
    feesCollected?: { fee0: bigint; fee1: bigint };
    message?: string;
  } {
    const position = this.positions.get(positionId);
    if (!position) {
      return { success: false, message: "Position not found" };
    }

    switch (action) {
      case "add":
        if (amountA === undefined || amountB === undefined) {
          return {
            success: false,
            message: "Amount A and B required for add action",
          };
        }
        position.amount0 += amountA;
        position.amount1 += amountB;
        position.liquidity = this.calculateVirtualLiquidity(
          position.tickLower,
          position.tickUpper,
          position.amount0,
          position.amount1
        );
        return {
          success: true,
          newAmountA: position.amount0,
          newAmountB: position.amount1,
        };

      case "remove":
        if (amountA === undefined || amountB === undefined) {
          return {
            success: false,
            message: "Amount A and B required for remove action",
          };
        }
        if (amountA > position.amount0 || amountB > position.amount1) {
          return { success: false, message: "Insufficient position balance" };
        }
        position.amount0 -= amountA;
        position.amount1 -= amountB;
        position.liquidity = this.calculateVirtualLiquidity(
          position.tickLower,
          position.tickUpper,
          position.amount0,
          position.amount1
        );
        return {
          success: true,
          newAmountA: position.amount0,
          newAmountB: position.amount1,
        };

      case "collect":
        const fees = this.calculatePositionFees(positionId);
        position.tokensOwed0 = 0n;
        position.tokensOwed1 = 0n;
        return { success: true, feesCollected: fees };

      default:
        return { success: false, message: "Invalid action" };
    }
  }

  // ===== BULK OPERATIONS FOR MULTIPLE POSITIONS =====

  /**
   * Create multiple positions in a single operation
   */
  createMultiplePositions(
    positionData: Array<{
      tickLower: number;
      tickUpper: number;
      amountA: bigint;
      amountB: bigint;
      positionId?: string;
    }>
  ): string[] {
    const createdIds: string[] = [];

    for (const data of positionData) {
      const id = this.createPosition(
        data.tickLower,
        data.tickUpper,
        data.amountA,
        data.amountB,
        data.positionId
      );
      createdIds.push(id);
    }

    return createdIds;
  }

  /**
   * Update multiple positions in a single operation
   */
  updateMultiplePositions(
    updates: Array<{
      positionId: string;
      amountADelta: bigint;
      amountBDelta: bigint;
    }>
  ): { success: boolean; failedIds: string[] } {
    const failedIds: string[] = [];

    for (const update of updates) {
      const success = this.updatePosition(
        update.positionId,
        update.amountADelta,
        update.amountBDelta
      );
      if (!success) {
        failedIds.push(update.positionId);
      }
    }

    return {
      success: failedIds.length === 0,
      failedIds,
    };
  }

  /**
   * Remove multiple positions in a single operation
   */
  removeMultiplePositions(positionIds: string[]): {
    success: boolean;
    removedIds: string[];
    failedIds: string[];
  } {
    const removedIds: string[] = [];
    const failedIds: string[] = [];

    for (const id of positionIds) {
      const success = this.removePosition(id);
      if (success) {
        removedIds.push(id);
      } else {
        failedIds.push(id);
      }
    }

    return {
      success: failedIds.length === 0,
      removedIds,
      failedIds,
    };
  }

  /**
   * Collect fees from multiple positions
   */
  collectMultipleFees(positionIds: string[]): {
    totalFees: { fee0: bigint; fee1: bigint };
    collectedFees: Map<string, { fee0: bigint; fee1: bigint }>;
    failedIds: string[];
  } {
    const collectedFees = new Map<string, { fee0: bigint; fee1: bigint }>();
    const failedIds: string[] = [];
    let totalFee0 = 0n;
    let totalFee1 = 0n;

    for (const id of positionIds) {
      const fees = this.collectFees(id);
      if (fees) {
        collectedFees.set(id, fees);
        totalFee0 += fees.fee0;
        totalFee1 += fees.fee1;
      } else {
        failedIds.push(id);
      }
    }

    return {
      totalFees: { fee0: totalFee0, fee1: totalFee1 },
      collectedFees,
      failedIds,
    };
  }

  // ===== POSITION FILTERING AND QUERYING =====

  /**
   * Get positions filtered by tick range
   */
  getPositionsInRange(tickLower: number, tickUpper: number): VirtualPosition[] {
    return Array.from(this.positions.values()).filter(
      (position) =>
        position.tickLower >= tickLower && position.tickUpper <= tickUpper
    );
  }

  /**
   * Get positions that are currently out of range (inactive)
   */
  getInactivePositions(): VirtualPosition[] {
    return Array.from(this.positions.values()).filter(
      (position) =>
        this.pool.tickCurrent < position.tickLower ||
        this.pool.tickCurrent >= position.tickUpper
    );
  }

  /**
   * Get positions with minimum liquidity threshold
   */
  getPositionsWithMinLiquidity(minLiquidity: bigint): VirtualPosition[] {
    return Array.from(this.positions.values()).filter(
      (position) => position.liquidity >= minLiquidity
    );
  }

  /**
   * Get positions with minimum fee earnings
   */
  getPositionsWithMinFees(minFee0: bigint, minFee1: bigint): VirtualPosition[] {
    return Array.from(this.positions.values()).filter((position) => {
      const fees = this.calculatePositionFees(position.id);
      return fees.fee0 >= minFee0 && fees.fee1 >= minFee1;
    });
  }

  /**
   * Get positions created within a time range
   */
  getPositionsByTimeRange(
    startTime: number,
    endTime: number
  ): VirtualPosition[] {
    return Array.from(this.positions.values()).filter(
      (position) =>
        position.createdAt >= startTime && position.createdAt <= endTime
    );
  }

  /**
   * Get positions sorted by a specific criteria
   */
  getPositionsSortedBy(
    criteria: "liquidity" | "amountA" | "amountB" | "createdAt" | "fees",
    ascending: boolean = true
  ): VirtualPosition[] {
    const positions = Array.from(this.positions.values());

    return positions.sort((a, b) => {
      let aValue: bigint | number;
      let bValue: bigint | number;

      switch (criteria) {
        case "liquidity":
          aValue = a.liquidity;
          bValue = b.liquidity;
          break;
        case "amountA":
          aValue = a.amount0;
          bValue = b.amount0;
          break;
        case "amountB":
          aValue = a.amount1;
          bValue = b.amount1;
          break;
        case "createdAt":
          aValue = a.createdAt;
          bValue = b.createdAt;
          break;
        case "fees":
          const aFees = this.calculatePositionFees(a.id);
          const bFees = this.calculatePositionFees(b.id);
          aValue = aFees.fee0 + aFees.fee1;
          bValue = bFees.fee0 + bFees.fee1;
          break;
        default:
          return 0;
      }

      if (aValue < bValue) return ascending ? -1 : 1;
      if (aValue > bValue) return ascending ? 1 : -1;
      return 0;
    });
  }

  /**
   * Get positions by multiple criteria
   */
  getPositionsByCriteria(criteria: {
    tickRange?: { lower: number; upper: number };
    minLiquidity?: bigint;
    minFees?: { fee0: bigint; fee1: bigint };
    timeRange?: { start: number; end: number };
    activeOnly?: boolean;
  }): VirtualPosition[] {
    let positions = Array.from(this.positions.values());

    if (criteria.tickRange) {
      positions = positions.filter(
        (pos) =>
          pos.tickLower >= criteria.tickRange!.lower &&
          pos.tickUpper <= criteria.tickRange!.upper
      );
    }

    if (criteria.minLiquidity !== undefined) {
      positions = positions.filter(
        (pos) => pos.liquidity >= criteria.minLiquidity!
      );
    }

    if (criteria.minFees) {
      positions = positions.filter((pos) => {
        const fees = this.calculatePositionFees(pos.id);
        return (
          fees.fee0 >= criteria.minFees!.fee0 &&
          fees.fee1 >= criteria.minFees!.fee1
        );
      });
    }

    if (criteria.timeRange) {
      positions = positions.filter(
        (pos) =>
          pos.createdAt >= criteria.timeRange!.start &&
          pos.createdAt <= criteria.timeRange!.end
      );
    }

    if (criteria.activeOnly) {
      positions = positions.filter(
        (pos) =>
          this.pool.tickCurrent >= pos.tickLower &&
          this.pool.tickCurrent < pos.tickUpper
      );
    }

    return positions;
  }

  // ===== POSITION ANALYTICS AND SUMMARY =====

  /**
   * Get comprehensive analytics for all positions
   */
  getPositionAnalytics(): {
    totalPositions: number;
    activePositions: number;
    inactivePositions: number;
    totalLiquidity: bigint;
    totalValue: bigint;
    totalFees: { fee0: bigint; fee1: bigint };
    averagePositionSize: bigint;
    largestPosition: VirtualPosition | null;
    smallestPosition: VirtualPosition | null;
    liquidityDistribution: {
      ranges: Array<{ range: string; count: number; totalLiquidity: bigint }>;
    };
  } {
    const positions = Array.from(this.positions.values());
    const activePositions = this.getActivePositions();
    const inactivePositions = this.getInactivePositions();

    let totalLiquidity = 0n;
    let totalValue = 0n;
    let totalFee0 = 0n;
    let totalFee1 = 0n;
    let largestPosition: VirtualPosition | null = null;
    let smallestPosition: VirtualPosition | null = null;

    const rangeMap = new Map<
      string,
      { count: number; totalLiquidity: bigint }
    >();

    for (const position of positions) {
      totalLiquidity += position.liquidity;
      totalValue += position.amount0 + position.amount1;

      const fees = this.calculatePositionFees(position.id);
      totalFee0 += fees.fee0;
      totalFee1 += fees.fee1;

      // Track largest and smallest positions
      if (!largestPosition || position.liquidity > largestPosition.liquidity) {
        largestPosition = position;
      }
      if (
        !smallestPosition ||
        position.liquidity < smallestPosition.liquidity
      ) {
        smallestPosition = position;
      }

      // Track liquidity distribution by range
      const rangeKey = `${position.tickLower}-${position.tickUpper}`;
      const existing = rangeMap.get(rangeKey);
      if (existing) {
        existing.count++;
        existing.totalLiquidity += position.liquidity;
      } else {
        rangeMap.set(rangeKey, {
          count: 1,
          totalLiquidity: position.liquidity,
        });
      }
    }

    const averagePositionSize =
      positions.length > 0 ? totalLiquidity / BigInt(positions.length) : 0n;

    return {
      totalPositions: positions.length,
      activePositions: activePositions.length,
      inactivePositions: inactivePositions.length,
      totalLiquidity,
      totalValue,
      totalFees: { fee0: totalFee0, fee1: totalFee1 },
      averagePositionSize,
      largestPosition,
      smallestPosition,
      liquidityDistribution: {
        ranges: Array.from(rangeMap.entries()).map(([range, data]) => ({
          range,
          count: data.count,
          totalLiquidity: data.totalLiquidity,
        })),
      },
    };
  }

  /**
   * Get performance metrics for positions
   */
  getPositionPerformanceMetrics(): {
    totalReturn: number;
    averageReturn: number;
    bestPerformingPosition: {
      position: VirtualPosition;
      return: number;
    } | null;
    worstPerformingPosition: {
      position: VirtualPosition;
      return: number;
    } | null;
    positionsAboveWater: number;
    positionsBelowWater: number;
  } {
    const positions = Array.from(this.positions.values());
    let totalReturn = 0;
    let positionsAboveWater = 0;
    let positionsBelowWater = 0;
    let bestReturn = -Infinity;
    let worstReturn = Infinity;
    let bestPosition: VirtualPosition | null = null;
    let worstPosition: VirtualPosition | null = null;

    for (const position of positions) {
      const currentValue = position.amount0 + position.amount1;
      const fees = this.calculatePositionFees(position.id);
      const totalValue = currentValue + fees.fee0 + fees.fee1;

      // Calculate return based on initial investment (simplified)
      const initialValue = this.initialAmount0 + this.initialAmount1;
      const returnRate =
        initialValue > 0n ? Number(totalValue) / Number(initialValue) - 1 : 0;

      totalReturn += returnRate;

      if (returnRate > 0) {
        positionsAboveWater++;
      } else {
        positionsBelowWater++;
      }

      if (returnRate > bestReturn) {
        bestReturn = returnRate;
        bestPosition = position;
      }

      if (returnRate < worstReturn) {
        worstReturn = returnRate;
        worstPosition = position;
      }
    }

    const averageReturn =
      positions.length > 0 ? totalReturn / positions.length : 0;

    return {
      totalReturn,
      averageReturn,
      bestPerformingPosition: bestPosition
        ? { position: bestPosition, return: bestReturn }
        : null,
      worstPerformingPosition: worstPosition
        ? { position: worstPosition, return: worstReturn }
        : null,
      positionsAboveWater,
      positionsBelowWater,
    };
  }

  /**
   * Get risk metrics for positions
   */
  getPositionRiskMetrics(): {
    concentrationRisk: number;
    liquidityRisk: number;
    rangeRisk: number;
    diversificationScore: number;
  } {
    const positions = Array.from(this.positions.values());
    if (positions.length === 0) {
      return {
        concentrationRisk: 0,
        liquidityRisk: 0,
        rangeRisk: 0,
        diversificationScore: 1,
      };
    }

    // Calculate concentration risk (Herfindahl index)
    const totalLiquidity = positions.reduce(
      (sum, pos) => sum + pos.liquidity,
      0n
    );
    let concentrationRisk = 0;
    for (const position of positions) {
      const share = Number(position.liquidity) / Number(totalLiquidity);
      concentrationRisk += share * share;
    }

    // Calculate liquidity risk (positions with low liquidity)
    const lowLiquidityPositions = positions.filter(
      (pos) => pos.liquidity < totalLiquidity / BigInt(positions.length) / 10n
    );
    const liquidityRisk = lowLiquidityPositions.length / positions.length;

    // Calculate range risk (positions out of range)
    const outOfRangePositions = this.getInactivePositions();
    const rangeRisk = outOfRangePositions.length / positions.length;

    // Calculate diversification score (inverse of concentration risk)
    const diversificationScore = 1 - concentrationRisk;

    return {
      concentrationRisk,
      liquidityRisk,
      rangeRisk,
      diversificationScore,
    };
  }

  /**
   * Get summary report for all positions
   */
  getPositionSummary(): {
    overview: {
      totalPositions: number;
      activePositions: number;
      totalValue: bigint;
      totalFees: { fee0: bigint; fee1: bigint };
    };
    analytics: ReturnType<VirtualPositionManager["getPositionAnalytics"]>;
    performance: ReturnType<
      VirtualPositionManager["getPositionPerformanceMetrics"]
    >;
    risk: ReturnType<VirtualPositionManager["getPositionRiskMetrics"]>;
  } {
    const analytics = this.getPositionAnalytics();
    const performance = this.getPositionPerformanceMetrics();
    const risk = this.getPositionRiskMetrics();

    return {
      overview: {
        totalPositions: analytics.totalPositions,
        activePositions: analytics.activePositions,
        totalValue: analytics.totalValue,
        totalFees: analytics.totalFees,
      },
      analytics,
      performance,
      risk,
    };
  }

  clearAll(): void {
    this.positions.clear();
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
    let amountA = 0n;
    let amountB = 0n;
    let feesOwed0 = 0n;
    let feesOwed1 = 0n;

    for (const position of this.positions.values()) {
      amountA += position.amount0;
      amountB += position.amount1;
      feesOwed0 += position.tokensOwed0;
      feesOwed1 += position.tokensOwed1;
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
      collectedFees0: this.totalFeesCollected0,
      collectedFees1: this.totalFeesCollected1,
      totalCostTokenA: this.totalCostTokenA,
      totalCostTokenB: this.totalCostTokenB,
    };
  }

  collectFees(positionId: string): { fee0: bigint; fee1: bigint } | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    // Calculate current fees to collect. When in-range, calculatePositionFees returns
    // only the delta since last checkpoint, so we must add tokensOwed. When out-of-range,
    // calculatePositionFees already returns tokensOwed.
    const inRange =
      this.pool.tickCurrent >= position.tickLower &&
      this.pool.tickCurrent < position.tickUpper;

    const snapshot = this.calculatePositionFees(positionId);
    const totalFee0 = inRange
      ? position.tokensOwed0 + snapshot.fee0
      : snapshot.fee0;
    const totalFee1 = inRange
      ? position.tokensOwed1 + snapshot.fee1
      : snapshot.fee1;

    // Reset tokensOwed (we've now collected them)
    position.tokensOwed0 = 0n;
    position.tokensOwed1 = 0n;

    // Update checkpoint to current feeGrowthInside so we don't double-count
    if (inRange) {
      position.feeGrowthInside0LastX64 = this.pool.calculateFeeGrowthInside(
        position.tickLower,
        position.tickUpper,
        0
      );
      position.feeGrowthInside1LastX64 = this.pool.calculateFeeGrowthInside(
        position.tickLower,
        position.tickUpper,
        1
      );
    }

    // Add to cash and total collected
    this.amount0 += totalFee0;
    this.amount1 += totalFee1;
    this.totalFeesCollected0 += totalFee0;
    this.totalFeesCollected1 += totalFee1;

    return { fee0: totalFee0, fee1: totalFee1 };
  }

  recordSwap(
    positionId: string,
    amountIn: bigint,
    amountOut: bigint,
    zeroForOne: boolean
  ): boolean {
    const position = this.positions.get(positionId);
    if (!position) return false;

    if (zeroForOne) {
      if (position.amount0 + this.amount0 < amountIn) return false;
      position.amount0 -= amountIn;
      position.amount1 += amountOut;
    } else {
      if (position.amount1 + this.amount1 < amountIn) return false;
      position.amount1 -= amountIn;
      position.amount0 += amountOut;
    }

    position.liquidity = this.calculateVirtualLiquidity(
      position.tickLower,
      position.tickUpper,
      position.amount0,
      position.amount1
    );
    return true;
  }

  /**
   * Add liquidity to an existing position
   * @param positionId The ID of the position to add liquidity to
   * @param amount0 The amount of token0 to add
   * @param amount1 The amount of token1 to add
   * @param actionCost Optional action cost for the operation
   * @returns Object containing liquidity information and amounts used
   */
  addLiquidity(
    positionId: string,
    amount0: bigint,
    amount1: bigint,
    actionCost?: ActionCost
  ): {
    success: boolean;
    addedLiquidity: bigint;
    totalLiquidity: bigint;
    usedAmount0: bigint;
    usedAmount1: bigint;
    refundAmount0: bigint;
    refundAmount1: bigint;
    message?: string;
  } {
    const position = this.positions.get(positionId);
    if (!position) {
      return {
        success: false,
        addedLiquidity: 0n,
        totalLiquidity: 0n,
        usedAmount0: 0n,
        usedAmount1: 0n,
        refundAmount0: amount0,
        refundAmount1: amount1,
        message: "Position not found",
      };
    }

    if (amount0 < 0n || amount1 < 0n) {
      return {
        success: false,
        addedLiquidity: 0n,
        totalLiquidity: position.liquidity,
        usedAmount0: 0n,
        usedAmount1: 0n,
        refundAmount0: amount0,
        refundAmount1: amount1,
        message: "Amounts must be non-negative",
      };
    }

    // Check if we have enough balance
    if (amount0 > this.amount0 || amount1 > this.amount1) {
      return {
        success: false,
        addedLiquidity: 0n,
        totalLiquidity: position.liquidity,
        usedAmount0: 0n,
        usedAmount1: 0n,
        refundAmount0: amount0,
        refundAmount1: amount1,
        message: `Insufficient balance: need ${amount0} token0, ${amount1} token1, have ${this.amount0} token0, ${this.amount1} token1`,
      };
    }

    try {
      // Calculate how much liquidity can be added with the provided amounts
      const funding = this.computePositionFunding(
        position.tickLower,
        position.tickUpper,
        amount0,
        amount1
      );

      if (funding.liquidity <= 0n) {
        return {
          success: false,
          addedLiquidity: 0n,
          totalLiquidity: position.liquidity,
          usedAmount0: 0n,
          usedAmount1: 0n,
          refundAmount0: amount0,
          refundAmount1: amount1,
          message: "Cannot derive liquidity from provided amounts",
        };
      }

      // Store original position state for rollback if needed
      const originalAmount0 = position.amount0;
      const originalAmount1 = position.amount1;
      const originalLiquidity = position.liquidity;
      const originalCash0 = this.amount0;
      const originalCash1 = this.amount1;

      try {
        // Update position amounts
        position.amount0 += funding.usedA;
        position.amount1 += funding.usedB;

        // Calculate new total liquidity for the position
        const newTotalLiquidity = this.calculateVirtualLiquidity(
          position.tickLower,
          position.tickUpper,
          position.amount0,
          position.amount1
        );

        // Validate that total virtual liquidity doesn't exceed pool liquidity ratio
        const poolLiquidity = this.pool.liquidity;
        const currentActiveLiquidity = this.getTotalActiveLiquidity();
        const liquidityIncrease = newTotalLiquidity - originalLiquidity;
        const totalAfterAddition =
          currentActiveLiquidity - originalLiquidity + newTotalLiquidity;
        const maxAllowed =
          (poolLiquidity * BigInt(Math.floor(this.maxLiquidityRatio * 1000))) /
          1000n;

        if (totalAfterAddition > maxAllowed) {
          // Rollback changes
          position.amount0 = originalAmount0;
          position.amount1 = originalAmount1;
          position.liquidity = originalLiquidity;

          const ratio = (
            (Number(totalAfterAddition) / Number(poolLiquidity)) *
            100
          ).toFixed(2);
          return {
            success: false,
            addedLiquidity: 0n,
            totalLiquidity: originalLiquidity,
            usedAmount0: 0n,
            usedAmount1: 0n,
            refundAmount0: amount0,
            refundAmount1: amount1,
            message: `Cannot add liquidity: total virtual liquidity would exceed ${(
              this.maxLiquidityRatio * 100
            ).toFixed(0)}% of pool liquidity. Would be ${ratio}% of pool.`,
          };
        }

        // Update position liquidity
        position.liquidity = newTotalLiquidity;

        // Deduct used amounts from cash balance
        this.amount0 -= funding.usedA;
        this.amount1 -= funding.usedB;

        // Apply action cost
        this.applyActionCost(actionCost);

        console.log(
          `[VirtualPositionManager] Added liquidity to position ${positionId}: +${liquidityIncrease} L (total: ${newTotalLiquidity}), used ${funding.usedA} token0 + ${funding.usedB} token1`
        );

        return {
          success: true,
          addedLiquidity: liquidityIncrease,
          totalLiquidity: newTotalLiquidity,
          usedAmount0: funding.usedA,
          usedAmount1: funding.usedB,
          refundAmount0: funding.refundA,
          refundAmount1: funding.refundB,
          message: `Successfully added ${liquidityIncrease} liquidity to position`,
        };
      } catch (error) {
        // Rollback all changes on any error
        position.amount0 = originalAmount0;
        position.amount1 = originalAmount1;
        position.liquidity = originalLiquidity;
        this.amount0 = originalCash0;
        this.amount1 = originalCash1;

        return {
          success: false,
          addedLiquidity: 0n,
          totalLiquidity: originalLiquidity,
          usedAmount0: 0n,
          usedAmount1: 0n,
          refundAmount0: amount0,
          refundAmount1: amount1,
          message: `Failed to add liquidity: ${(error as Error).message}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        addedLiquidity: 0n,
        totalLiquidity: position.liquidity,
        usedAmount0: 0n,
        usedAmount1: 0n,
        refundAmount0: amount0,
        refundAmount1: amount1,
        message: `Error calculating liquidity: ${(error as Error).message}`,
      };
    }
  }

  private calculateVirtualLiquidity(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): bigint {
    return this.computePositionFunding(tickLower, tickUpper, amountA, amountB)
      .liquidity;
  }

  private computePositionFunding(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): {
    liquidity: bigint;
    usedA: bigint;
    usedB: bigint;
    refundA: bigint;
    refundB: bigint;
  } {
    if (tickLower >= tickUpper) {
      return {
        liquidity: 0n,
        usedA: 0n,
        usedB: 0n,
        refundA: amountA,
        refundB: amountB,
      };
    }

    const sqrtLower = this.pool.tickToSqrtPrice(tickLower);
    const sqrtUpper = this.pool.tickToSqrtPrice(tickUpper);
    const sqrtCurrent = this.pool.sqrtPriceX64;
    const currentTick = this.pool.tickCurrent;

    let liquidity = 0n;
    let usedA = 0n;
    let usedB = 0n;

    if (currentTick < tickLower) {
      liquidity = this.liquidityForAmount0(amountA, sqrtLower, sqrtUpper);
      usedA = this.amount0ForLiquidity(liquidity, sqrtLower, sqrtUpper);
    } else if (currentTick >= tickUpper) {
      liquidity = this.liquidityForAmount1(amountB, sqrtLower, sqrtUpper);
      usedB = this.amount1ForLiquidity(liquidity, sqrtLower, sqrtUpper);
    } else {
      const liquidityFromA = this.liquidityForAmount0(
        amountA,
        sqrtCurrent,
        sqrtUpper
      );
      const liquidityFromB = this.liquidityForAmount1(
        amountB,
        sqrtLower,
        sqrtCurrent
      );

      liquidity =
        liquidityFromA < liquidityFromB ? liquidityFromA : liquidityFromB;

      usedA = this.amount0ForLiquidity(liquidity, sqrtCurrent, sqrtUpper);
      usedB = this.amount1ForLiquidity(liquidity, sqrtLower, sqrtCurrent);
    }

    if (usedA > amountA) usedA = amountA;
    if (usedB > amountB) usedB = amountB;

    const refundA = amountA - usedA;
    const refundB = amountB - usedB;

    if (liquidity <= 0n && usedA === 0n && usedB === 0n) {
      return { liquidity: 0n, usedA: 0n, usedB: 0n, refundA, refundB };
    }

    return {
      liquidity,
      usedA,
      usedB,
      refundA,
      refundB,
    };
  }

  private liquidityForAmount0(
    amount: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint
  ): bigint {
    if (amount <= 0n || sqrtLower >= sqrtUpper) return 0n;
    const product = this.mulDiv(
      sqrtUpper,
      sqrtLower,
      VirtualPositionManager.Q64
    );
    if (product === 0n) return 0n;
    return this.mulDiv(amount, product, sqrtUpper - sqrtLower);
  }

  private liquidityForAmount1(
    amount: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint
  ): bigint {
    if (amount <= 0n || sqrtLower >= sqrtUpper) return 0n;
    return this.mulDiv(
      amount,
      VirtualPositionManager.Q64,
      sqrtUpper - sqrtLower
    );
  }

  private amount0ForLiquidity(
    liquidity: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint
  ): bigint {
    if (liquidity <= 0n || sqrtLower >= sqrtUpper) return 0n;
    const product = this.mulDiv(
      sqrtUpper,
      sqrtLower,
      VirtualPositionManager.Q64
    );
    if (product === 0n) return 0n;
    return this.mulDiv(liquidity, sqrtUpper - sqrtLower, product);
  }

  private amount1ForLiquidity(
    liquidity: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint
  ): bigint {
    if (liquidity <= 0n || sqrtLower >= sqrtUpper) return 0n;
    return this.mulDiv(
      liquidity,
      sqrtUpper - sqrtLower,
      VirtualPositionManager.Q64
    );
  }

  private findSwapAmount(
    amountNeededOut: bigint,
    maxAmountIn: bigint,
    zeroForOne: boolean,
    maxSlippageBps: number
  ): {
    amountIn: bigint;
    amountOut: bigint;
    slippageExceeded: boolean;
  } | null {
    if (maxAmountIn <= 0n) return null;

    const slippageLimit = maxSlippageBps / 100;
    let low = 1n;
    let high = maxAmountIn;
    let bestIn = 0n;
    let bestOut = 0n;
    let exceeded = false;

    while (low <= high) {
      const mid = (low + high) >> 1n;
      const { amountOut, priceImpact } = this.pool.estimateAmountOut(
        mid,
        zeroForOne
      );

      if (amountOut <= 0n) {
        low = mid + 1n;
        continue;
      }

      if (!Number.isFinite(priceImpact) || priceImpact > slippageLimit) {
        high = mid - 1n;
        continue;
      }

      bestIn = mid;
      bestOut = amountOut;

      if (amountNeededOut > 0n && amountOut >= amountNeededOut) {
        exceeded = false;
        high = mid - 1n;
      } else {
        low = mid + 1n;
        if (amountNeededOut > 0n) {
          exceeded = true;
        }
      }
    }

    if (bestIn === 0n || bestOut === 0n) {
      return null;
    }

    if (amountNeededOut > 0n && bestOut < amountNeededOut) {
      exceeded = true;
    }

    return {
      amountIn: bestIn,
      amountOut: bestOut,
      slippageExceeded: exceeded,
    };
  }

  private mulDiv(
    a: bigint,
    b: bigint,
    denominator: bigint,
    roundUp = false
  ): bigint {
    if (denominator === 0n) return 0n;
    const product = a * b;
    const quotient = product / denominator;
    if (!roundUp || product % denominator === 0n) {
      return quotient;
    }
    return quotient + 1n;
  }

  recordActionCost(cost?: ActionCost) {
    this.applyActionCost(cost);
  }

  private applyActionCost(cost?: ActionCost) {
    if (!cost) return;
    if (cost.tokenA && cost.tokenA > 0) {
      this.totalCostTokenA += cost.tokenA;
    }
    if (cost.tokenB && cost.tokenB > 0) {
      this.totalCostTokenB += cost.tokenB;
    }
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
}
