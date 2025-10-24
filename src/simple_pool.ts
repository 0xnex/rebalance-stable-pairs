import type {
  IPool,
  ISlippageProvider,
  SwapEvent,
  OptimizationResult,
  MaxLResult,
} from "./types";

export class SimplePool implements IPool {
  public readonly token0: string;
  public readonly token1: string;
  public readonly decimals0: number;
  public readonly decimals1: number;
  public readonly tickSpacing: number;
  public readonly feeTier: number;
  public sqrtPriceX64: bigint = 0n;
  public tick: number = 0;
  public reserve0: bigint = 0n;
  public reserve1: bigint = 0n;
  public liquidity: bigint = 0n;
  public totalFee0: bigint = 0n;
  public totalFee1: bigint = 0n;

  private slipMrg: ISlippageProvider;

  private static readonly Q64 = 1n << 64n;

  private static readonly PPM = 1000000;

  constructor(
    token0: string,
    token1: string,
    decimals0: number,
    decimals1: number,
    feeTier: number, // PPM based
    tickSpacing: number,
    slipMrg: ISlippageProvider
  ) {
    this.token0 = token0;
    this.token1 = token1;
    this.tickSpacing = tickSpacing;
    this.feeTier = feeTier;
    this.decimals0 = decimals0;
    this.decimals1 = decimals1;
    this.slipMrg = slipMrg;
  }

  swap(
    amountIn: bigint,
    xForY: boolean
  ): { amountOut: bigint; fee: bigint; slippage: bigint } {
    if (amountIn <= 0n) {
      return { amountOut: 0n, fee: 0n, slippage: 0n };
    }

    // Calculate fee: fee = amountIn * feeTier / 1000000
    const fee = (amountIn * BigInt(this.feeTier)) / BigInt(SimplePool.PPM);
    const amountInAfterFee = amountIn - fee;

    if (amountInAfterFee <= 0n) {
      return { amountOut: 0n, fee, slippage: 0n };
    }

    // Get current price
    const currentPrice = this.price();

    // Calculate base amountOut using price
    let amountOut: bigint;
    if (xForY) {
      // Selling token0 for token1: amountOut = amountIn * price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) * currentPrice));
    } else {
      // Selling token1 for token0: amountOut = amountIn / price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) / currentPrice));
    }

    // Apply slippage: get slippage percentage and reduce amountOut
    // Use amountInAfterFee since that's the actual amount being swapped
    const slippagePct = this.slipMrg.getSlippagePct(
      amountInAfterFee,  // Use amount after fee deduction
      xForY,
      currentPrice
    );
    const slippageAmount = BigInt(Math.floor(Number(amountOut) * slippagePct));
    amountOut = amountOut - slippageAmount;

    // Ensure amountOut is not negative
    if (amountOut < 0n) {
      amountOut = 0n;
    }

    return {
      amountOut,
      fee,
      slippage: slippageAmount,
    };
  }

  /**
   * Calculate the maximum liquidity that can be provided with given amounts of tokens
   * This is a simple calculation without any swaps
   * @param amount0 Amount of token0 available
   * @param amount1 Amount of token1 available
   * @param lower Lower tick boundary
   * @param upper Upper tick boundary
   * @returns Maximum liquidity and token amounts used
   */
  private calculateMaxLiquidity(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): MaxLResult {
    // Get current sqrt price and tick boundaries
    const sqrtPriceX64 = this.sqrtPriceX64;
    const sqrtPriceLower = this.tickToSqrtPrice(lower);
    const sqrtPriceUpper = this.tickToSqrtPrice(upper);

    // Calculate maximum liquidity using CLMM formula
    const L = this.calculateLiquidityFromAmounts(
      sqrtPriceX64,
      sqrtPriceLower,
      sqrtPriceUpper,
      amount0,
      amount1
    );

    // Calculate actual amounts that will be used with this liquidity
    const { amount0: amount0Used, amount1: amount1Used } =
      this.calculateAmountsFromLiquidity(
        sqrtPriceX64,
        sqrtPriceLower,
        sqrtPriceUpper,
        L
      );

    return {
      L,
      amount0Used,
      amount1Used,
      fee0: 0n,
      fee1: 0n,
      slip0: 0n,
      slip1: 0n,
    };
  }

  /**
   * Get maximum liquidity by given token amounts and tick range, with optional one-time swap optimization
   * @param amount0 Amount of token0 available
   * @param amount1 Amount of token1 available
   * @param lower Lower tick boundary (must be aligned to tickSpacing)
   * @param upper Upper tick boundary (must be aligned to tickSpacing)
   * @returns Maximum liquidity result (without swap details for simple maxL interface)
   */
  maxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): MaxLResult {
    // Validate tick alignment
    if (lower % this.tickSpacing !== 0) {
      throw new Error(
        `Lower tick ${lower} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (upper % this.tickSpacing !== 0) {
      throw new Error(
        `Upper tick ${upper} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (lower >= upper) {
      throw new Error(
        `Lower tick ${lower} must be less than upper tick ${upper}`
      );
    }

    return this.calculateMaxLiquidity(amount0, amount1, lower, upper);
  }

  /**
   * Remove liquidity from a position and calculate the token amounts to be withdrawn
   * @param deltaLiquidity Amount of liquidity to remove
   * @param lower Lower tick boundary (must be aligned to tickSpacing)
   * @param upper Upper tick boundary (must be aligned to tickSpacing)
   * @returns Token amounts to be withdrawn (amount0, amount1)
   */
  removeLiquidity(
    deltaLiquidity: bigint,
    lower: number,
    upper: number
  ): { amount0: bigint; amount1: bigint } {
    // Validate tick alignment
    if (lower % this.tickSpacing !== 0) {
      throw new Error(
        `Lower tick ${lower} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (upper % this.tickSpacing !== 0) {
      throw new Error(
        `Upper tick ${upper} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (lower >= upper) {
      throw new Error(
        `Lower tick ${lower} must be less than upper tick ${upper}`
      );
    }
    if (deltaLiquidity <= 0n) {
      throw new Error("Delta liquidity must be greater than zero");
    }

    // Get current sqrt price and tick boundaries
    const sqrtPriceX64 = this.sqrtPriceX64;
    const sqrtPriceLower = this.tickToSqrtPrice(lower);
    const sqrtPriceUpper = this.tickToSqrtPrice(upper);

    // Calculate the amounts to be withdrawn using the existing helper
    const { amount0, amount1 } = this.calculateAmountsFromLiquidity(
      sqrtPriceX64,
      sqrtPriceLower,
      sqrtPriceUpper,
      deltaLiquidity
    );

    return { amount0, amount1 };
  }

  /**
   * Calculate liquidity from token amounts
   * Based on Uniswap V3 formula
   */
  private calculateLiquidityFromAmounts(
    sqrtPriceX64: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint,
    amount0: bigint,
    amount1: bigint
  ): bigint {
    if (sqrtPriceLower > sqrtPriceUpper) {
      [sqrtPriceLower, sqrtPriceUpper] = [sqrtPriceUpper, sqrtPriceLower];
    }

    let liquidity: bigint;

    if (sqrtPriceX64 <= sqrtPriceLower) {
      // Current price is below the range - only token0 will be used
      // L = amount0 * (sqrtPriceLower * sqrtPriceUpper) / (sqrtPriceUpper - sqrtPriceLower)
      // Adjusted for Q64.64 format: L = amount0 * sqrtPriceLower * sqrtPriceUpper / ((sqrtPriceUpper - sqrtPriceLower) * 2^64)
      const numerator = amount0 * sqrtPriceLower * sqrtPriceUpper;
      const denominator = (sqrtPriceUpper - sqrtPriceLower) * SimplePool.Q64;
      liquidity = numerator / denominator;
    } else if (sqrtPriceX64 >= sqrtPriceUpper) {
      // Current price is above the range - only token1 will be used
      // L = amount1 * 2^64 / (sqrtPriceUpper - sqrtPriceLower)
      liquidity =
        (amount1 * SimplePool.Q64) / (sqrtPriceUpper - sqrtPriceLower);
    } else {
      // Current price is in range - both tokens will be used
      // Calculate liquidity from token0: L0 = amount0 * (sqrtPrice * sqrtPriceUpper) / (sqrtPriceUpper - sqrtPrice)
      const liquidity0 =
        (amount0 * sqrtPriceX64 * sqrtPriceUpper) /
        ((sqrtPriceUpper - sqrtPriceX64) * SimplePool.Q64);

      // Calculate liquidity from token1: L1 = amount1 * 2^64 / (sqrtPrice - sqrtPriceLower)
      const liquidity1 =
        (amount1 * SimplePool.Q64) / (sqrtPriceX64 - sqrtPriceLower);

      // Take the minimum to ensure we don't exceed either token amount
      liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
    }

    return liquidity;
  }

  /**
   * Calculate token amounts from liquidity
   * Based on Uniswap V3 formula
   */
  private calculateAmountsFromLiquidity(
    sqrtPriceX64: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint,
    liquidity: bigint
  ): { amount0: bigint; amount1: bigint } {
    if (sqrtPriceLower > sqrtPriceUpper) {
      [sqrtPriceLower, sqrtPriceUpper] = [sqrtPriceUpper, sqrtPriceLower];
    }

    let amount0 = 0n;
    let amount1 = 0n;

    if (sqrtPriceX64 <= sqrtPriceLower) {
      // Current price is below the range - only token0 needed
      // amount0 = L * (sqrtPriceUpper - sqrtPriceLower) * 2^64 / (sqrtPriceLower * sqrtPriceUpper)
      amount0 =
        (liquidity * (sqrtPriceUpper - sqrtPriceLower) * SimplePool.Q64) /
        (sqrtPriceLower * sqrtPriceUpper);
    } else if (sqrtPriceX64 >= sqrtPriceUpper) {
      // Current price is above the range - only token1 needed
      // amount1 = L * (sqrtPriceUpper - sqrtPriceLower) / 2^64
      amount1 = (liquidity * (sqrtPriceUpper - sqrtPriceLower)) / SimplePool.Q64;
    } else {
      // Current price is in range - both tokens needed
      // amount0 = L * (sqrtPriceUpper - sqrtPrice) * 2^64 / (sqrtPrice * sqrtPriceUpper)
      amount0 =
        (liquidity * (sqrtPriceUpper - sqrtPriceX64) * SimplePool.Q64) /
        (sqrtPriceX64 * sqrtPriceUpper);

      // amount1 = L * (sqrtPrice - sqrtPriceLower) / 2^64
      amount1 = (liquidity * (sqrtPriceX64 - sqrtPriceLower)) / SimplePool.Q64;
    }

    return { amount0, amount1 };
  }

  /**
   * Convert tick to sqrt price in Q64.64 format
   * Validates that tick is aligned to tickSpacing
   */
  private tickToSqrtPrice(tick: number): bigint {
    // Validate tick alignment to tickSpacing
    if (tick % this.tickSpacing !== 0) {
      throw new Error(
        `Tick ${tick} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    
    const sqrtPrice = Math.sqrt(1.0001 ** tick);
    return BigInt(Math.floor(sqrtPrice * Number(SimplePool.Q64)));
  }

  /**
   * Align tick to tickSpacing (round down to nearest valid tick)
   */
  private alignTickToSpacing(tick: number): number {
    return Math.floor(tick / this.tickSpacing) * this.tickSpacing;
  }

  /**
   * Optimize token ratio with one swap to maximize liquidity
   * Uses analytical approach to calculate exact swap needed based on price range
   * @param amount0 Current amount of token0
   * @param amount1 Current amount of token1
   * @param lower Lower tick boundary (must be aligned to tickSpacing)
   * @param upper Upper tick boundary (must be aligned to tickSpacing)
   * @param minSwapThreshold Minimum amount to swap (skip swap if below threshold, default 0)
   * @returns Optimization result with swap details and maximum liquidity
   */
  optimizeForMaxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number,
    minSwapThreshold: bigint = 0n
  ): OptimizationResult {
    // Validate tick alignment
    if (lower % this.tickSpacing !== 0) {
      throw new Error(
        `Lower tick ${lower} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (upper % this.tickSpacing !== 0) {
      throw new Error(
        `Upper tick ${upper} is not aligned to tickSpacing ${this.tickSpacing}`
      );
    }
    if (lower >= upper) {
      throw new Error(
        `Lower tick ${lower} must be less than upper tick ${upper}`
      );
    }

    // Calculate original liquidity without swapping
    const originalMaxL = this.calculateMaxLiquidity(amount0, amount1, lower, upper);

    const sqrtPriceX64 = this.sqrtPriceX64;
    const sqrtPriceLower = this.tickToSqrtPrice(lower);
    const sqrtPriceUpper = this.tickToSqrtPrice(upper);

    let needSwap = false;
    let swapDirection: "0to1" | "1to0" | null = null;
    let swapAmount = 0n;
    let swapReceived = 0n;
    let swapFee = 0n;
    let swapSlippage = 0n;
    let finalAmount0 = amount0;
    let finalAmount1 = amount1;

    // Case 1: Price range is entirely below current price - only need token0
    if (sqrtPriceX64 >= sqrtPriceUpper) {
      // Swap all token1 to token0
      if (amount1 > minSwapThreshold) {
        needSwap = true;
        swapDirection = "1to0";
        swapAmount = amount1;
        const swapResult = this.swap(amount1, false);
        swapReceived = swapResult.amountOut;
        swapFee = swapResult.fee;
        swapSlippage = swapResult.slippage;
        finalAmount0 = amount0 + swapResult.amountOut;
        finalAmount1 = 0n;
      }
    }
    // Case 2: Price range is entirely above current price - only need token1
    else if (sqrtPriceX64 <= sqrtPriceLower) {
      // Swap all token0 to token1
      if (amount0 > minSwapThreshold) {
        needSwap = true;
        swapDirection = "0to1";
        swapAmount = amount0;
        const swapResult = this.swap(amount0, true);
        swapReceived = swapResult.amountOut;
        swapFee = swapResult.fee;
        swapSlippage = swapResult.slippage;
        finalAmount0 = 0n;
        finalAmount1 = amount1 + swapResult.amountOut;
      }
    }
    // Case 3: Current price is in range - need both tokens in specific ratio
    else {
      // Calculate the required ratio of token1 to token0
      // For position in range:
      // amount0 = L * (sqrtPriceUpper - sqrtPrice) * 2^64 / (sqrtPrice * sqrtPriceUpper)
      // amount1 = L * (sqrtPrice - sqrtPriceLower) / 2^64
      //
      // Ratio: amount1 / amount0 = (sqrtPrice - sqrtPriceLower) * sqrtPrice * sqrtPriceUpper / ((sqrtPriceUpper - sqrtPrice) * 2^64 * 2^64)

      // Convert to floating point for ratio calculation
      const sqrtP = Number(sqrtPriceX64);
      const sqrtA = Number(sqrtPriceLower);
      const sqrtB = Number(sqrtPriceUpper);
      const Q64_NUM = Number(SimplePool.Q64);

      // Calculate required ratio (token1 / token0)
      const requiredRatio =
        ((sqrtP - sqrtA) * sqrtP * sqrtB) /
        ((sqrtB - sqrtP) * Q64_NUM * Q64_NUM);

      // Calculate current ratio
      const currentRatio =
        amount1 > 0n && amount0 > 0n ? Number(amount1) / Number(amount0) : 0;

      // Determine if we need to swap and in which direction
      if (currentRatio > requiredRatio * 1.01) {
        // We have too much token1, swap some token1 → token0
        // Calculate how much to swap to achieve the required ratio
        // After swap: (amount1 - swapAmt) / (amount0 + swapOut) = requiredRatio
        // Assuming swapOut ≈ swapAmt * price (ignoring fees/slippage for estimation)
        const price = this.price();
        const targetAmount1 = requiredRatio * (Number(amount0) + Number(amount1) / price);
        const swapEstimate = Math.max(0, Number(amount1) - targetAmount1);

        if (swapEstimate > 0) {
          swapAmount = BigInt(Math.floor(swapEstimate));
          // Cap swap amount to available amount1
          if (swapAmount > amount1) swapAmount = amount1;

          if (swapAmount > minSwapThreshold) {
            needSwap = true;
            swapDirection = "1to0";
            const swapResult = this.swap(swapAmount, false);
            swapReceived = swapResult.amountOut;
            swapFee = swapResult.fee;
            swapSlippage = swapResult.slippage;
            finalAmount0 = amount0 + swapResult.amountOut;
            finalAmount1 = amount1 - swapAmount;
          }
        }
      } else if (currentRatio < requiredRatio * 0.99) {
        // We have too much token0, swap some token0 → token1
        const price = this.price();
        const targetAmount0 = (Number(amount1) + Number(amount0) * price) / requiredRatio / price;
        const swapEstimate = Math.max(0, Number(amount0) - targetAmount0);

        if (swapEstimate > 0) {
          swapAmount = BigInt(Math.floor(swapEstimate));
          // Cap swap amount to available amount0
          if (swapAmount > amount0) swapAmount = amount0;

          if (swapAmount > minSwapThreshold) {
            needSwap = true;
            swapDirection = "0to1";
            const swapResult = this.swap(swapAmount, true);
            swapReceived = swapResult.amountOut;
            swapFee = swapResult.fee;
            swapSlippage = swapResult.slippage;
            finalAmount0 = amount0 - swapAmount;
            finalAmount1 = amount1 + swapResult.amountOut;
          }
        }
      }
      // else: ratio is close enough, no swap needed
    }

    // Calculate final max liquidity
    const finalMaxL = this.calculateMaxLiquidity(
      finalAmount0,
      finalAmount1,
      lower,
      upper
    );

    // Calculate improvement percentage
    const improvementPct =
      Number(finalMaxL.L) > Number(originalMaxL.L)
        ? ((Number(finalMaxL.L) - Number(originalMaxL.L)) /
            Number(originalMaxL.L)) *
          100
        : 0;

    return {
      needSwap,
      swapDirection,
      swapAmount,
      swapResult: needSwap
        ? {
            amountOut: swapReceived,
            fee: swapFee,
            slippage: swapSlippage,
          }
        : undefined,
      finalAmount0,
      finalAmount1,
      maxLResult: finalMaxL,
      improvement: {
        originalL: originalMaxL.L,
        optimizedL: finalMaxL.L,
        improvementPct,
      },
      // Calculate remaining amounts (not used for liquidity)
      remainingAmount0: finalAmount0 - finalMaxL.amount0Used,
      remainingAmount1: finalAmount1 - finalMaxL.amount1Used,
    };
  }

  onSwapEvent(evt: SwapEvent): void {
    if (evt.zeroForOne) {
      this.totalFee0 += evt.feeAmount;
    } else {
      this.totalFee1 += evt.feeAmount;
    }
    this.liquidity += evt.liquidity;
    this.sqrtPriceX64 = evt.sqrtPriceAfter;
    this.tick = evt.tick;
    this.reserve0 = evt.reserveA;
    this.reserve1 = evt.reserveB;
  }

  price(): number {
    const sqrtPrice = Number(this.sqrtPriceX64) / Number(SimplePool.Q64);
    return sqrtPrice * sqrtPrice;
  }
}
