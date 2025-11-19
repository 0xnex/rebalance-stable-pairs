/**
 * Pool active liquidity calculation utilities
 *
 * This module provides functions to calculate the active liquidity of a pool
 * from swap event data, which is essential for understanding pool depth and fee distribution.
 */

import { getMaxSlippage } from "./slippage/slippage";

/**
 * Constants for precision and calculations
 */
export class LiquidityConstants {
  static readonly Q64 = 2n ** 64n;
  static readonly Q128 = 2n ** 128n;
  static readonly MIN_TICK = -887272;
  static readonly MAX_TICK = 887272;
}

/**
 * Result interface for amount calculations from liquidity
 */
export interface AmountResult {
  amount0: bigint;
  amount1: bigint;
}

export type MaxLiquidityResult = {
  liquidity: bigint;
  remain0: bigint;
  remain1: bigint;
  swapCost0: bigint;
  swapCost1: bigint;
  slippage0: bigint;
  slippage1: bigint;
};

/**
 * Pool active liquidity calculator class
 */
export class LiquidityCalculator {
  /**
   * Convert sqrtPriceX64 to raw price
   * @param sqrtPriceX64 - Sqrt price in Q64.64 format
   * @returns Price as a number (token1/token0)
   */
  static sqrtPriceX64ToPrice(sqrtPriceX64: bigint): number {
    const Q64 = LiquidityConstants.Q64;
    const Q128 = LiquidityConstants.Q128;
    // price = (sqrtPriceX64 / 2^64)^2 = (sqrtPriceX64)^2 / 2^128
    const priceX128 = sqrtPriceX64 * sqrtPriceX64;
    return Number(priceX128) / Number(Q128);
  }

  /**
   * Calculate maximum liquidity for given token amounts, allowing one optimal swap
   * @param sqrtPriceX64 - Current sqrt price in Q64.64 format
   * @param feeRatePpm - Fee rate in parts per million (e.g., 3000 for 0.3%)
   * @param lowerTick - Lower tick of the range
   * @param upperTick - Upper tick of the range
   * @param amount0 - Available amount of token0
   * @param amount1 - Available amount of token1
   * @returns MaxLiquidityResult
   */
  static maxLiquidity(
    sqrtPriceX64: bigint,
    feeRatePpm: number,
    lowerTick: number,
    upperTick: number,
    amount0: bigint,
    amount1: bigint,
    tokenConfig: {
      name0: string;
      name1: string;
      decimals0: number;
      decimals1: number;
    }
  ): MaxLiquidityResult {
    if (amount0 <= 0n && amount1 <= 0n) {
      return {
        liquidity: 0n,
        remain0: 0n,
        remain1: 0n,
        swapCost0: 0n,
        swapCost1: 0n,
        slippage0: 0n,
        slippage1: 0n,
      };
    }

    // Convert ticks to sqrt prices
    const sqrtPriceLower = this.tickToSqrtPriceX64(lowerTick);
    const sqrtPriceUpper = this.tickToSqrtPriceX64(upperTick);

    // Validate price range
    if (sqrtPriceLower >= sqrtPriceUpper) {
      throw new Error(
        "Invalid price range: lower tick must be less than upper tick"
      );
    }

    // Get current tick for comparison
    const currentTick = this.sqrtPriceToTick(sqrtPriceX64);
    const currentPrice = this.sqrtPriceX64ToPrice(sqrtPriceX64);

    // Determine position relative to range using tick comparison
    const tickPosition = this.getTickPosition(
      currentTick,
      lowerTick,
      upperTick
    );

    let working0 = amount0;
    let working1 = amount1;
    let totalFee0 = 0n;
    let totalFee1 = 0n;
    let totalSlippage0 = 0n;
    let totalSlippage1 = 0n;

    // Case 1: Only one token
    if (amount0 === 0n || amount1 === 0n) {
      // Swap 50% of the single token to the other
      if (amount0 > 0n) {
        const swapAmount = amount0 / 2n;
        const {
          amountOut,
          swapFee: fee,
          slippage,
        } = this.simulateSwap(
          swapAmount,
          true, // token0 -> token1
          currentPrice,
          feeRatePpm,
          tokenConfig
        );
        working0 = amount0 - swapAmount;
        working1 = amountOut;
        totalFee0 = fee;
        totalSlippage1 = slippage;
      } else {
        const swapAmount = amount1 / 2n;
        const {
          amountOut,
          swapFee: fee,
          slippage,
        } = this.simulateSwap(
          swapAmount,
          false, // token1 -> token0
          currentPrice,
          feeRatePpm,
          tokenConfig
        );
        working1 = amount1 - swapAmount;
        working0 = amountOut;
        totalFee1 = fee;
        totalSlippage0 = slippage;
      }
    }

    // Case 2: Both tokens present - try without swap first
    let bestLiquidity = this.calculateLiquidityFromAmounts(
      working0,
      working1,
      sqrtPriceX64,
      sqrtPriceLower,
      sqrtPriceUpper
    );

    let bestRemain0 = 0n;
    let bestRemain1 = 0n;

    // Calculate remainders after using best liquidity
    if (bestLiquidity > 0n) {
      const used0 = this.amount0ForLiquidity(
        bestLiquidity,
        sqrtPriceX64,
        sqrtPriceUpper
      );
      const used1 = this.amount1ForLiquidity(
        bestLiquidity,
        sqrtPriceLower,
        sqrtPriceX64
      );
      bestRemain0 = working0 - used0;
      bestRemain1 = working1 - used1;

      // Ensure non-negative remainders
      if (bestRemain0 < 0n) bestRemain0 = 0n;
      if (bestRemain1 < 0n) bestRemain1 = 0n;
    } else {
      bestRemain0 = working0;
      bestRemain1 = working1;
    }

    // Case 3: Try swapping if we have a significant remainder (>20% of total value)
    const totalValue0 =
      working0 + BigInt(Math.floor(Number(working1) / currentPrice));
    const remain0Value =
      bestRemain0 + BigInt(Math.floor(Number(bestRemain1) / currentPrice));

    if (totalValue0 > 0n && remain0Value * 5n > totalValue0) {
      // >20%
      // Determine which token has larger remainder
      const remain0InToken0 = bestRemain0;
      const remain1InToken0 = BigInt(
        Math.floor(Number(bestRemain1) / currentPrice)
      );

      if (remain0InToken0 > remain1InToken0 && bestRemain0 > 0n) {
        // Swap 80% of token0 remainder to token1
        const swapAmount = (bestRemain0 * 8n) / 10n;
        const {
          amountOut,
          swapFee: fee,
          slippage,
        } = this.simulateSwap(
          swapAmount,
          true,
          currentPrice,
          feeRatePpm,
          tokenConfig
        );

        const test0 = working0 - swapAmount;
        const test1 = working1 + amountOut;
        const testLiquidity = this.calculateLiquidityFromAmounts(
          test0,
          test1,
          sqrtPriceX64,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        // Use swap if it improves liquidity
        if (testLiquidity > bestLiquidity) {
          working0 = test0;
          working1 = test1;
          bestLiquidity = testLiquidity;
          totalFee0 += fee;
          totalSlippage1 += slippage;

          const used0 = this.amount0ForLiquidity(
            bestLiquidity,
            sqrtPriceX64,
            sqrtPriceUpper
          );
          const used1 = this.amount1ForLiquidity(
            bestLiquidity,
            sqrtPriceLower,
            sqrtPriceX64
          );
          bestRemain0 = working0 - used0;
          bestRemain1 = working1 - used1;
          if (bestRemain0 < 0n) bestRemain0 = 0n;
          if (bestRemain1 < 0n) bestRemain1 = 0n;
        }
      } else if (remain1InToken0 > remain0InToken0 && bestRemain1 > 0n) {
        // Swap 80% of token1 remainder to token0
        const swapAmount = (bestRemain1 * 8n) / 10n;
        const {
          amountOut,
          swapFee: fee,
          slippage,
        } = this.simulateSwap(
          swapAmount,
          false,
          currentPrice,
          feeRatePpm,
          tokenConfig
        );

        const test0 = working0 + amountOut;
        const test1 = working1 - swapAmount;
        const testLiquidity = this.calculateLiquidityFromAmounts(
          test0,
          test1,
          sqrtPriceX64,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        // Use swap if it improves liquidity
        if (testLiquidity > bestLiquidity) {
          working0 = test0;
          working1 = test1;
          bestLiquidity = testLiquidity;
          totalFee1 += fee;
          totalSlippage0 += slippage;

          const used0 = this.amount0ForLiquidity(
            bestLiquidity,
            sqrtPriceX64,
            sqrtPriceUpper
          );
          const used1 = this.amount1ForLiquidity(
            bestLiquidity,
            sqrtPriceLower,
            sqrtPriceX64
          );
          bestRemain0 = working0 - used0;
          bestRemain1 = working1 - used1;
          if (bestRemain0 < 0n) bestRemain0 = 0n;
          if (bestRemain1 < 0n) bestRemain1 = 0n;
        }
      }
    }

    console.log(
      `[MaxLiquidity] Tick: ${currentTick} (range: [${lowerTick}, ${upperTick}]), ` +
        `Position: ${tickPosition}, ` +
        `Input: [${amount0}, ${amount1}], ` +
        `Liquidity: ${bestLiquidity}, ` +
        `Remain: [${bestRemain0}, ${bestRemain1}], ` +
        `Fees: [${totalFee0}, ${totalFee1}], ` +
        `Slippage: [${totalSlippage0}, ${totalSlippage1}]`
    );

    return {
      liquidity: bestLiquidity,
      remain0: bestRemain0,
      remain1: bestRemain1,
      swapCost0: totalFee0,
      swapCost1: totalFee1,
      slippage0: totalSlippage0,
      slippage1: totalSlippage1,
    };
  }

  /**
   * Helper to determine tick position relative to range
   */
  private static getTickPosition(
    currentTick: number,
    lowerTick: number,
    upperTick: number
  ): "below" | "in" | "above" {
    if (currentTick < lowerTick) return "below";
    if (currentTick > upperTick) return "above";
    return "in";
  }

  /**
   * Calculate the optimal ratio of token1 to token0 (in token0 terms) for maximum liquidity
   * This is based on the geometric mean and price range boundaries
   */
  private static calculateOptimalRatio(
    sqrtPriceCurrent: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint
  ): number {
    const currentPrice =
      (Number(sqrtPriceCurrent) / Number(LiquidityConstants.Q64)) ** 2;
    const lowerPrice =
      (Number(sqrtPriceLower) / Number(LiquidityConstants.Q64)) ** 2;
    const upperPrice =
      (Number(sqrtPriceUpper) / Number(LiquidityConstants.Q64)) ** 2;

    // If current price is outside the range, handle edge cases
    if (currentPrice <= lowerPrice) {
      // Price is below range - only token0 is needed
      return 0;
    }

    if (currentPrice >= upperPrice) {
      // Price is above range - only token1 is needed
      return 1;
    }

    // For in-range positions, calculate the optimal ratio based on Uniswap V3 math
    // The optimal ratio depends on the current price and range boundaries

    // Calculate the sqrt prices
    const sqrtP = Math.sqrt(currentPrice);
    const sqrtPa = Math.sqrt(lowerPrice);
    const sqrtPb = Math.sqrt(upperPrice);

    // For a given liquidity L, the amounts are:
    // amount0 = L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb)
    // amount1 = L * (sqrtP - sqrtPa)

    // The ratio of amount1 to amount0 (in terms of token0 value) is:
    // ratio = (amount1 / currentPrice) / amount0
    // ratio = (L * (sqrtP - sqrtPa) / currentPrice) / (L * (sqrtPb - sqrtP) / (sqrtP * sqrtPb))
    // ratio = (sqrtP - sqrtPa) * sqrtP * sqrtPb / (currentPrice * (sqrtPb - sqrtP))
    // ratio = (sqrtP - sqrtPa) * sqrtP * sqrtPb / (sqrtP^2 * (sqrtPb - sqrtP))
    // ratio = (sqrtP - sqrtPa) * sqrtPb / (sqrtP * (sqrtPb - sqrtP))

    const numerator = (sqrtP - sqrtPa) * sqrtPb;
    const denominator = sqrtP * (sqrtPb - sqrtP);

    if (denominator === 0) {
      return 0.5; // Fallback to balanced
    }

    const ratio = numerator / denominator;

    // The total ratio should be: token1_value / (token0_value + token1_value)
    // So we need: token1_value / total_value = ratio / (1 + ratio)
    const normalizedRatio = ratio / (1 + ratio);

    // Clamp between 0 and 1
    return Math.max(0, Math.min(1, normalizedRatio));
  }

  /**
   * Calculate liquidity from token amounts for a given price range
   */
  private static calculateLiquidityFromAmounts(
    amount0: bigint,
    amount1: bigint,
    sqrtPriceCurrent: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint
  ): bigint {
    if (amount0 <= 0n && amount1 <= 0n) {
      return 0n;
    }

    let liquidity0 = 0n;
    let liquidity1 = 0n;

    // Calculate liquidity from token0 (if current price < upper price)
    if (sqrtPriceCurrent < sqrtPriceUpper && amount0 > 0n) {
      const sqrtPriceA =
        sqrtPriceCurrent > sqrtPriceLower ? sqrtPriceCurrent : sqrtPriceLower;
      const sqrtPriceB = sqrtPriceUpper;

      // L = amount0 * (sqrtPriceA * sqrtPriceB) / (sqrtPriceB - sqrtPriceA) / Q64
      const numerator = this.mulDiv(
        amount0,
        sqrtPriceA,
        LiquidityConstants.Q64
      );
      const denominator = sqrtPriceB - sqrtPriceA;

      if (denominator > 0n) {
        liquidity0 = this.mulDiv(numerator, sqrtPriceB, denominator);
      }
    }

    // Calculate liquidity from token1 (if current price > lower price)
    if (sqrtPriceCurrent >= sqrtPriceLower && amount1 > 0n) {
      const sqrtPriceA = sqrtPriceLower;
      const sqrtPriceB =
        sqrtPriceCurrent < sqrtPriceUpper ? sqrtPriceCurrent : sqrtPriceUpper;

      // L = amount1 * Q64 / (sqrtPriceB - sqrtPriceA)
      const denominator = sqrtPriceB - sqrtPriceA;

      if (denominator > 0n) {
        liquidity1 = this.mulDiv(amount1, LiquidityConstants.Q64, denominator);
      }
    }

    // Return the minimum (limiting factor)
    return liquidity0 > 0n && liquidity1 > 0n
      ? liquidity0 < liquidity1
        ? liquidity0
        : liquidity1
      : liquidity0 > liquidity1
      ? liquidity0
      : liquidity1;
  }

  /**
   * Simulate a swap with fees and slippage
   */

  static PPM = 1_000_000;
  static DEFAULT_SLIPPAGE_PCT = 0.1; // 0.1%
  private static simulateSwap(
    amountIn: bigint,
    zeroForOne: boolean,
    currentPrice: number,
    feeRatePpm: number,
    tokenConfig: {
      name0: string;
      name1: string;
      decimals0: number;
      decimals1: number;
    }
  ): { amountOut: bigint; swapFee: bigint; slippage: bigint } {
    if (amountIn <= 0n) {
      return { amountOut: 0n, swapFee: 0n, slippage: 0n };
    }

    // Calculate fee
    const fee = (amountIn * BigInt(feeRatePpm)) / 1_000_000n;
    const amountInAfterFee = amountIn - fee;
    console.log(
      `[simulateSwap] amountIn:${amountIn}, feeRatePpm: ${feeRatePpm}, fee: ${fee}, amountInAfterFee: ${amountInAfterFee}`
    );

    if (amountInAfterFee <= 0n) {
      return { amountOut: 0n, swapFee: fee, slippage: 0n };
    }

    // Calculate amount out based on current price
    let slippagePct = zeroForOne
      ? getMaxSlippage(
          tokenConfig.name0,
          tokenConfig.name1,
          Number(amountInAfterFee) / Math.pow(10, tokenConfig.decimals0)
        )
      : getMaxSlippage(
          tokenConfig.name1,
          tokenConfig.name0,
          Number(amountInAfterFee) / Math.pow(10, tokenConfig.decimals1)
        );

    console.log(
      `[simulateSwap] slippagePct: ${slippagePct}, name0: ${tokenConfig.name0}, name1: ${tokenConfig.name1}, decimals0: ${tokenConfig.decimals0}, decimals1: ${tokenConfig.decimals1}, amountInAfterFee: ${amountInAfterFee}`
    );

    if (slippagePct === null || slippagePct >= 1 || slippagePct < 0) {
      slippagePct = this.DEFAULT_SLIPPAGE_PCT;
    }

    // Calculate amount out before slippage
    let amountOutBeforeSlippage: bigint;
    if (zeroForOne) {
      // token0 -> token1: multiply by price
      amountOutBeforeSlippage = BigInt(
        Math.floor(Number(amountInAfterFee) * currentPrice)
      );
    } else {
      // token1 -> token0: divide by price
      amountOutBeforeSlippage = BigInt(
        Math.floor(Number(amountInAfterFee) / currentPrice)
      );
    }

    // Apply slippage to get final amount out

    const slippage = BigInt(
      Math.floor((Number(amountOutBeforeSlippage) * slippagePct) / 100)
    );
    const amountOut = amountOutBeforeSlippage - BigInt(slippage);

    return {
      amountOut,
      swapFee: fee,
      slippage,
    };
  }

  /**
   * Estimate fee allocation for multiple positions using ACTUAL pool liquidity from swap event
   * This is MORE ACCURATE than estimateMultiPositionFeesFromSwap which calculates liquidity
   *
   * @param poolLiquidity - Actual pool liquidity from the swap event (preferred!)
   * @param swapTick - Tick after the swap
   * @param amountIn - Amount of tokens swapped in (before fee deduction)
   * @param zeroForOne - Direction of swap (token0 -> token1)
   * @param feeRatePpm - Fee rate in parts per million (e.g., 100 for 0.01%)
   * @param positions - Array of positions with { liquidity, tickLower, tickUpper }
   * @returns Array of { fee0, fee1, isActive } for each position
   */
  static estimateMultiPositionFeesFromSwapWithPoolLiquidity(
    poolLiquidity: bigint,
    swapTick: number,
    amountIn: bigint,
    zeroForOne: boolean,
    feeRatePpm: number,
    positions: Array<{
      liquidity: bigint;
      tickLower: number;
      tickUpper: number;
    }>
  ): Array<{ fee0: bigint; fee1: bigint; isActive: boolean }> {
    // Calculate total swap fees
    const totalFeeAmount = (amountIn * BigInt(feeRatePpm)) / 1_000_000n;

    if (poolLiquidity === 0n) {
      return positions.map(() => ({ fee0: 0n, fee1: 0n, isActive: false }));
    }

    // Calculate each position's liquidity if active
    let totalActivePositionLiquidity = 0n;
    const positionData = positions.map((pos) => {
      const isActive = swapTick >= pos.tickLower && swapTick < pos.tickUpper;
      if (isActive && pos.liquidity > 0n) {
        totalActivePositionLiquidity += pos.liquidity;
      }
      return { ...pos, isActive };
    });

    // If no positions are active, return zeros
    if (totalActivePositionLiquidity === 0n) {
      return positionData.map((p) => ({
        fee0: 0n,
        fee1: 0n,
        isActive: p.isActive,
      }));
    }

    // Calculate allocation cap to prevent over-allocation
    // If totalActivePositionLiquidity > poolLiquidity, cap at 100%
    // Otherwise, use the ratio of position liquidity to pool liquidity
    const allocationCap =
      totalActivePositionLiquidity > poolLiquidity
        ? LiquidityConstants.Q64 // 100% cap
        : this.mulDiv(
            totalActivePositionLiquidity,
            LiquidityConstants.Q64,
            poolLiquidity
          );

    // Allocate fees proportionally to each active position
    return positionData.map((pos) => {
      if (!pos.isActive || pos.liquidity === 0n) {
        return { fee0: 0n, fee1: 0n, isActive: false };
      }

      // Calculate this position's share of active liquidity
      const positionShare = this.mulDiv(
        pos.liquidity,
        LiquidityConstants.Q64,
        totalActivePositionLiquidity
      );

      // Apply the allocation cap and calculate final fee
      const cappedShare = this.mulDiv(
        positionShare,
        allocationCap,
        LiquidityConstants.Q64
      );

      const allocatedFee = this.mulDiv(
        totalFeeAmount,
        cappedShare,
        LiquidityConstants.Q64
      );

      // Assign to correct token based on swap direction
      if (zeroForOne) {
        return { fee0: allocatedFee, fee1: 0n, isActive: true };
      } else {
        return { fee0: 0n, fee1: allocatedFee, isActive: true };
      }
    });
  }

  /**
   * Calculate active liquidity from swap event data
   * This estimates the total active liquidity in the pool at the current tick
   *
   * @param sqrtPriceBefore - Sqrt price before the swap
   * @param sqrtPriceAfter - Sqrt price after the swap
   * @param amountIn - Amount of tokens swapped in
   * @param amountOut - Amount of tokens received
   * @param zeroForOne - Direction of swap (token0 -> token1)
   * @returns Estimated active liquidity
   */
  static calculateActiveLiquidityFromSwap(
    sqrtPriceBefore: bigint,
    sqrtPriceAfter: bigint,
    amountIn: bigint,
    amountOut: bigint,
    zeroForOne: boolean
  ): bigint {
    if (
      sqrtPriceBefore === sqrtPriceAfter ||
      amountIn === 0n ||
      amountOut === 0n
    ) {
      return 0n;
    }

    // For Uniswap V3, the relationship between price change and liquidity is:
    // ΔL = Δ(1/√P) * amount1  (for token0 -> token1 swaps)
    // ΔL = Δ√P * amount0      (for token1 -> token0 swaps)

    if (zeroForOne) {
      // Token0 -> Token1 swap
      // L = amount1 / (1/√P_after - 1/√P_before)
      // L = amount1 / ((√P_before - √P_after) / (√P_before * √P_after))
      // L = (amount1 * √P_before * √P_after) / (√P_before - √P_after)

      if (sqrtPriceBefore <= sqrtPriceAfter) {
        return 0n; // Invalid: price should decrease for 0->1 swap
      }

      const numerator = this.mulDiv(
        amountOut,
        this.mulDiv(sqrtPriceBefore, sqrtPriceAfter, LiquidityConstants.Q64),
        LiquidityConstants.Q64
      );

      return this.mulDiv(
        numerator,
        LiquidityConstants.Q64,
        sqrtPriceBefore - sqrtPriceAfter
      );
    } else {
      // Token1 -> Token0 swap
      // L = amount0 / (√P_after - √P_before)

      if (sqrtPriceAfter <= sqrtPriceBefore) {
        return 0n; // Invalid: price should increase for 1->0 swap
      }

      return this.mulDiv(
        amountOut,
        LiquidityConstants.Q64,
        sqrtPriceAfter - sqrtPriceBefore
      );
    }
  }

  /**
   * Calculate token amounts needed for a specific liquidity amount
   *
   * @param liquidity - Desired liquidity amount
   * @param sqrtPriceCurrent - Current sqrt price (Q64.64 format)
   * @param sqrtPriceLower - Lower bound sqrt price (Q64.64 format)
   * @param sqrtPriceUpper - Upper bound sqrt price (Q64.64 format)
   * @returns AmountResult with required token0 and token1 amounts
   */
  static calculateAmountsForLiquidity(
    liquidity: bigint,
    sqrtPriceCurrent: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint
  ): AmountResult {
    if (liquidity <= 0n) {
      return { amount0: 0n, amount1: 0n };
    }

    if (sqrtPriceLower >= sqrtPriceUpper) {
      throw new Error("Invalid price range: lower must be less than upper");
    }

    let amount0 = 0n;
    let amount1 = 0n;

    // Case 1: Current price is below the range (only token0 needed)
    if (sqrtPriceCurrent < sqrtPriceLower) {
      amount0 = this.amount0ForLiquidity(
        liquidity,
        sqrtPriceLower,
        sqrtPriceUpper
      );
      amount1 = 0n;
    }
    // Case 2: Current price is above the range (only token1 needed)
    else if (sqrtPriceCurrent >= sqrtPriceUpper) {
      amount0 = 0n;
      amount1 = this.amount1ForLiquidity(
        liquidity,
        sqrtPriceLower,
        sqrtPriceUpper
      );
    }
    // Case 3: Current price is within the range (both tokens needed)
    else {
      amount0 = this.amount0ForLiquidity(
        liquidity,
        sqrtPriceCurrent,
        sqrtPriceUpper
      );
      amount1 = this.amount1ForLiquidity(
        liquidity,
        sqrtPriceLower,
        sqrtPriceCurrent
      );
    }

    return { amount0, amount1 };
  }

  /**
   * Calculate token0 amount from liquidity and price range
   * Formula: amount0 = L * (sqrt(upper) - sqrt(lower)) / (sqrt(upper) * sqrt(lower))
   */
  static amount0ForLiquidity(
    liquidity: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint
  ): bigint {
    if (liquidity <= 0n || sqrtPriceLower >= sqrtPriceUpper) {
      return 0n;
    }

    const numerator = this.mulDiv(
      liquidity,
      sqrtPriceUpper - sqrtPriceLower,
      LiquidityConstants.Q64
    );
    const product = this.mulDiv(
      sqrtPriceUpper,
      sqrtPriceLower,
      LiquidityConstants.Q64
    );

    if (product === 0n) return 0n;

    return this.mulDiv(numerator, LiquidityConstants.Q64, product);
  }

  /**
   * Calculate token1 amount from liquidity and price range
   * Formula: amount1 = L * (sqrt(upper) - sqrt(lower)) / Q64
   */
  static amount1ForLiquidity(
    liquidity: bigint,
    sqrtPriceLower: bigint,
    sqrtPriceUpper: bigint
  ): bigint {
    if (liquidity <= 0n || sqrtPriceLower >= sqrtPriceUpper) {
      return 0n;
    }

    return this.mulDiv(
      liquidity,
      sqrtPriceUpper - sqrtPriceLower,
      LiquidityConstants.Q64
    );
  }

  /**
   * Convert tick to sqrt price
   * Formula: sqrt(1.0001^tick) * 2^64
   *
   * This is the full Uniswap V3 tick math implementation
   */
  static tickToSqrtPriceX64(tick: number): bigint {
    if (
      tick < LiquidityConstants.MIN_TICK ||
      tick > LiquidityConstants.MAX_TICK
    ) {
      throw new Error(`Tick ${tick} out of valid range`);
    }

    const absTick = tick < 0 ? -tick : tick;

    // Start with 2^128
    let ratio = 0x100000000000000000000000000000000n;

    // Multiply by precomputed values for each bit position
    // These values represent sqrt(1.0001^(2^i)) in Q128 format
    if (absTick & 0x1)
      ratio = (ratio * 0xfffcb933bd6fad37aa2d162d1a594001n) >> 128n;
    if (absTick & 0x2)
      ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
    if (absTick & 0x4)
      ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
    if (absTick & 0x8)
      ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
    if (absTick & 0x10)
      ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
    if (absTick & 0x20)
      ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
    if (absTick & 0x40)
      ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
    if (absTick & 0x80)
      ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
    if (absTick & 0x100)
      ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
    if (absTick & 0x200)
      ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
    if (absTick & 0x400)
      ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
    if (absTick & 0x800)
      ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
    if (absTick & 0x1000)
      ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
    if (absTick & 0x2000)
      ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
    if (absTick & 0x4000)
      ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
    if (absTick & 0x8000)
      ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
    if (absTick & 0x10000)
      ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
    if (absTick & 0x20000)
      ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
    if (absTick & 0x40000)
      ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
    if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

    // For negative ticks, take the reciprocal
    if (tick > 0)
      ratio = (LiquidityConstants.Q128 * LiquidityConstants.Q128) / ratio;

    // Convert from Q128 to Q64
    // ratio is now sqrtPrice in Q128, we need Q64
    return ratio >> 64n;
  }

  /**
   * Convert sqrt price to tick
   * Formula: tick = floor(log(price) / log(1.0001))
   * @param sqrtPriceX64 - Square root price in Q64.64 format
   * @param tickSpacing - Optional tick spacing for alignment (default: 1, no alignment)
   */
  static sqrtPriceToTick(
    sqrtPriceX64: bigint,
    tickSpacing: number = 1
  ): number {
    if (sqrtPriceX64 <= 0n) {
      throw new Error("Sqrt price must be positive");
    }

    // Check for extreme values that would clamp to min/max tick
    const minSqrtPrice = this.tickToSqrtPriceX64(LiquidityConstants.MIN_TICK);
    const maxSqrtPrice = this.tickToSqrtPriceX64(LiquidityConstants.MAX_TICK);

    if (sqrtPriceX64 < minSqrtPrice) {
      return LiquidityConstants.MIN_TICK;
    }
    if (sqrtPriceX64 > maxSqrtPrice) {
      return LiquidityConstants.MAX_TICK;
    }

    // Convert sqrt price to actual price
    const sqrtPrice = Number(sqrtPriceX64) / Number(LiquidityConstants.Q64);
    const actualPrice = sqrtPrice * sqrtPrice;

    // Handle edge case for price = 1.0
    if (Math.abs(actualPrice - 1.0) < 1e-10) {
      return 0;
    }

    // Calculate tick using logarithm
    // Use floor to ensure proper tick alignment (like Uniswap V3)
    let tick = Math.floor(Math.log(actualPrice) / Math.log(1.0001));

    // Align to tick spacing if specified
    if (tickSpacing > 1) {
      tick = Math.floor(tick / tickSpacing) * tickSpacing;
    }

    // Final clamp to valid range after alignment
    if (tick < LiquidityConstants.MIN_TICK) {
      return LiquidityConstants.MIN_TICK;
    }
    if (tick > LiquidityConstants.MAX_TICK) {
      return LiquidityConstants.MAX_TICK;
    }

    return tick;
  }

  /**
   * Precision-safe multiplication and division
   * Equivalent to (a * b) / c but handles overflow
   */
  static mulDiv(a: bigint, b: bigint, c: bigint): bigint {
    if (c === 0n) {
      throw new Error("Division by zero");
    }

    // Handle the simple case first
    if (a === 0n || b === 0n) {
      return 0n;
    }

    // For large numbers, we need to be careful about overflow
    const product = a * b;

    // Check for overflow (simplified check)
    if (product / a !== b) {
      // Use more sophisticated overflow-safe multiplication
      // This is a simplified version - production code would use full precision math
      const aHigh = a >> 128n;
      const aLow = a & ((1n << 128n) - 1n);
      const bHigh = b >> 128n;
      const bLow = b & ((1n << 128n) - 1n);

      const result =
        (aHigh * bHigh * (1n << 128n) + aHigh * bLow + aLow * bHigh) *
          (1n << 128n) +
        aLow * bLow;
      return result / c;
    }

    return product / c;
  }
}
