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

/**
 * Result from maxLiquidity calculation
 *
 * Given input amounts (amount0, amount1), this function:
 * 1. Optionally swaps to achieve optimal ratio for maximum liquidity
 * 2. Deposits both tokens into a liquidity position
 * 3. Returns leftover amounts
 *
 * Fields explained:
 *
 * @property liquidity - The amount of liquidity created in the position
 *
 * @property depositedAmount0 - Amount of token0 deposited into the liquidity position (always >= 0)
 * @property depositedAmount1 - Amount of token1 deposited into the liquidity position (always >= 0)
 *
 * @property remain0 - Amount of token0 left over after accounting for costs (can be negative if costs exceed input)
 * @property remain1 - Amount of token1 left over after accounting for costs (can be negative if costs exceed input)
 * @property actualRemain0 - Physical amount of token0 left over (always >= 0)
 * @property actualRemain1 - Physical amount of token1 left over (always >= 0)
 *
 * @property swapFee0 - Swap fee paid in token0 (> 0 if swapped token0→token1, otherwise 0)
 * @property swapFee1 - Swap fee paid in token1 (> 0 if swapped token1→token0, otherwise 0)
 *
 * @property slip0 - Slippage lost in token0 (> 0 if swapped token1→token0, otherwise 0)
 * @property slip1 - Slippage lost in token1 (> 0 if swapped token0→token1, otherwise 0)
 *
 * ACCOUNTING MODEL (Approach A - Track ALL tokens separately):
 * ================================================================
 * The accounting invariant is:
 *   amount0 = depositedAmount0 + swapFee0 + slip0 + remain0
 *   amount1 = depositedAmount1 + swapFee1 + slip1 + remain1
 *
 * Key points:
 * - depositedAmount shows how much of each token went into the liquidity position
 * - swapFee shows fee paid in the INPUT token of the swap
 * - slip shows slippage lost in the OUTPUT token of the swap
 * - remain shows what's left after accounting for deposits and costs (can be negative)
 * - actualRemain shows what's physically left (always >= 0)
 * - Only one of (swapFee0, swapFee1) will be > 0 (the input token)
 * - Only one of (slip0, slip1) will be > 0 (the output token)
 * - remain can be negative when costs exceed what's available in that token
 * - actualRemain is always non-negative (physical reality)
 *
 * Example 1: Token0→Token1 swap
 * - Start with: 1000 token0, 0 token1
 * - Swap: 500 token0 → 495 token1 (fee: 5 token0, slippage: 5 token1 expected but not received)
 * - Deposit: 450 token0 + 450 token1 into liquidity
 * - Result:
 *   - depositedAmount0 = 450, depositedAmount1 = 450
 *   - swapFee0 = 5, swapFee1 = 0
 *   - slip0 = 0, slip1 = 5
 *   - remain0 = 1000 - 450 - 5 - 0 = 545
 *   - remain1 = 0 - 450 - 0 - 5 = -455 (negative! we "borrowed" from received swap output)
 *   - actualRemain0 = 50 (physically left: 1000 - 500 - 450)
 *   - actualRemain1 = 45 (physically left: 0 + 495 - 450)
 *
 * Example 2: Token1→Token0 swap
 * - Start with: 0 token0, 6000 token1
 * - Swap: 3000 token1 → 2985 token0 (fee: 3 token1, slippage: 12 token0 expected but not received)
 * - Deposit: 2900 token0 + 2900 token1 into liquidity
 * - Result:
 *   - depositedAmount0 = 2900, depositedAmount1 = 2900
 *   - swapFee0 = 0, swapFee1 = 3
 *   - slip0 = 12, slip1 = 0
 *   - remain0 = 0 - 2900 - 0 - 12 = -2912 (negative! we "borrowed" from received swap output)
 *   - remain1 = 6000 - 2900 - 3 - 0 = 3097
 *   - actualRemain0 = 85 (physically left: 0 + 2985 - 2900)
 *   - actualRemain1 = 100 (physically left: 6000 - 3000 - 2900)
 */
export type MaxLiquidityResult = {
  liquidity: bigint;
  remain0: bigint;
  remain1: bigint;
  actualRemain0: bigint;
  actualRemain1: bigint;
  swapFee0: bigint;
  swapFee1: bigint;
  slip0: bigint;
  slip1: bigint;
  depositedAmount0: bigint;
  depositedAmount1: bigint;
};

/**
 * Pool active liquidity calculator class
 */
export class LiquidityCalculator {
  /**
   * Convert sqrtPriceX64 to human-readable price
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
    amount1: bigint
  ): MaxLiquidityResult {
    if (amount0 <= 0n && amount1 <= 0n) {
      return {
        liquidity: 0n,
        remain0: 0n,
        remain1: 0n,
        actualRemain0: 0n,
        actualRemain1: 0n,
        swapFee0: 0n,
        swapFee1: 0n,
        slip0: 0n,
        slip1: 0n,
        depositedAmount0: 0n,
        depositedAmount1: 0n,
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

    // Calculate current price
    const currentPrice =
      (Number(sqrtPriceX64) / Number(LiquidityConstants.Q64)) ** 2;
    const lowerPrice =
      (Number(sqrtPriceLower) / Number(LiquidityConstants.Q64)) ** 2;
    const upperPrice =
      (Number(sqrtPriceUpper) / Number(LiquidityConstants.Q64)) ** 2;

    // Calculate the optimal ratio of token1 to token0 for maximum liquidity
    const optimalRatio = this.calculateOptimalRatio(
      sqrtPriceX64,
      sqrtPriceLower,
      sqrtPriceUpper
    );

    // Calculate total value in terms of token0
    const totalValueInToken0 =
      amount0 + BigInt(Math.floor(Number(amount1) / currentPrice));

    // Calculate optimal amounts based on the ratio
    const optimalAmount1InToken0 = BigInt(
      Math.floor(Number(totalValueInToken0) * optimalRatio)
    );
    const optimalAmount0 = totalValueInToken0 - optimalAmount1InToken0;
    const optimalAmount1 = BigInt(
      Math.floor(Number(optimalAmount1InToken0) * currentPrice)
    );

    // Strategy 1: No swap - calculate liquidity with current amounts
    const liquidityNoSwap = this.calculateLiquidityFromAmounts(
      amount0,
      amount1,
      sqrtPriceX64,
      sqrtPriceLower,
      sqrtPriceUpper
    );

    // Strategy 2: Optimal swap to achieve ideal ratio
    let bestResult: MaxLiquidityResult = {
      liquidity: liquidityNoSwap,
      remain0: amount0,
      remain1: amount1,
      actualRemain0: amount0,
      actualRemain1: amount1,
      swapFee0: 0n,
      swapFee1: 0n,
      slip0: 0n,
      slip1: 0n,
      depositedAmount0: 0n,
      depositedAmount1: 0n,
    };

    // Determine what swap is needed to reach optimal ratio
    const currentAmount1InToken0 = BigInt(
      Math.floor(Number(amount1) / currentPrice)
    );
    const needMoreToken1 = optimalAmount1InToken0 > currentAmount1InToken0;

    if (needMoreToken1 && amount0 > 0n) {
      // Need to swap token0 -> token1
      const swapAmount0 =
        amount0 > optimalAmount0 ? amount0 - optimalAmount0 : 0n;

      if (swapAmount0 > 0n) {
        // Get decimal for token0 (input token in this swap: token0 -> token1)
        const decimal = parseInt(process.env.TOKEN_A_DECIMALS || "8");
        const swapResult = this.simulateSwap(
          swapAmount0,
          true,
          currentPrice,
          feeRatePpm,
          50, // default slippageBps
          decimal
        );

        const newAmount0 = amount0 - swapAmount0;
        const newAmount1 = amount1 + swapResult.amountOut;

        const liquidity = this.calculateLiquidityFromAmounts(
          newAmount0,
          newAmount1,
          sqrtPriceX64,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        // Check if this is better (accounting for swap costs)
        const swapCost = swapResult.fee + swapResult.slippage;
        const improvement = liquidity - bestResult.liquidity;

        // Force swap if we started with only one token (amount1 was 0)
        // Otherwise require 2x improvement over swap cost
        const shouldSwap =
          amount1 === 0n ||
          (improvement > 0n && Number(improvement) > Number(swapCost) * 2);

        if (shouldSwap) {
          // Calculate amounts used for liquidity position (pure liquidity, no fees)
          const liquidityAmounts = this.calculateAmountsForLiquidity(
            liquidity,
            sqrtPriceX64,
            sqrtPriceLower,
            sqrtPriceUpper
          );

          // APPROACH A: Track ALL tokens separately
          // Accounting invariant for token0→token1 swap:
          //   amount0 = depositedAmount0 + swapFee0 + remain0
          //   amount1 = depositedAmount1 + slip1 + remain1
          //
          // Physical flow:
          //   1. Start with: amount0, amount1
          //   2. Swap: spend swapAmount0 (which includes fee), receive amountOut (reduced by slippage)
          //      - Fee paid: swapResult.fee (from token0)
          //      - Slippage lost: swapResult.slippage (from expected token1 output)
          //   3. After swap: (amount0 - swapAmount0), (amount1 + amountOut)
          //   4. Deposit into liquidity: liquidityAmounts.amount0, liquidityAmounts.amount1
          //   5. Remain: what's physically left
          //
          // Calculate physical remain:
          const actualRemain0 =
            amount0 - swapAmount0 - liquidityAmounts.amount0;
          const actualRemain1 =
            amount1 + swapResult.amountOut - liquidityAmounts.amount1;

          // Verify invariant (for debugging):
          // amount0 = swapAmount0 + actualRemain0 + depositedAmount0
          //         = (swapResult.fee + amountInAfterFee) + actualRemain0 + depositedAmount0
          //         = swapResult.fee + <converted> + actualRemain0 + depositedAmount0
          // We want: amount0 = swapFee0 + depositedAmount0 + remain0
          // Since swapAmount0 = fee + <what gets converted to token1>
          // And the <converted part> is not in our final token0 balance,
          // We have: amount0 = swapAmount0 + actualRemain0 + depositedAmount0
          //                  = fee + <converted> + actualRemain0 + depositedAmount0
          // Therefore: remain0 = actualRemain0 + <converted part>
          // But we want: amount0 = fee + depositedAmount0 + remain0
          // So: remain0 = amount0 - fee - depositedAmount0
          const remain0 = amount0 - swapResult.fee - liquidityAmounts.amount0;

          // For token1: amount1 = depositedAmount1 + slip1 + remain1
          // amount1 + amountOut = depositedAmount1 + remain1 (physically)
          // But amountOut = expectedOut - slippage
          // So: amount1 + expectedOut - slippage = depositedAmount1 + remain1
          // We want: amount1 = depositedAmount1 + slippage + remain1
          // Therefore: remain1 = amount1 - depositedAmount1 - slippage
          const remain1 =
            amount1 - liquidityAmounts.amount1 - swapResult.slippage;

          bestResult = {
            liquidity,
            remain0,
            remain1,
            actualRemain0,
            actualRemain1,
            swapFee0: swapResult.fee, // Fee is paid in input token (token0)
            swapFee1: 0n,
            slip0: 0n,
            slip1: swapResult.slippage, // Slippage is lost in output token (token1)
            depositedAmount0: liquidityAmounts.amount0,
            depositedAmount1: liquidityAmounts.amount1,
          };
        }
      }
    } else if (!needMoreToken1 && amount1 > 0n) {
      // Need to swap token1 -> token0
      const swapAmount1 =
        amount1 > optimalAmount1 ? amount1 - optimalAmount1 : 0n;

      if (swapAmount1 > 0n) {
        // Get decimal for token1 (input token in this swap: token1 -> token0)
        const decimal = parseInt(process.env.TOKEN_B_DECIMALS || "8");
        const swapResult = this.simulateSwap(
          swapAmount1,
          false,
          currentPrice,
          feeRatePpm,
          50, // default slippageBps
          decimal
        );

        const newAmount0 = amount0 + swapResult.amountOut;
        const newAmount1 = amount1 - swapAmount1;

        const liquidity = this.calculateLiquidityFromAmounts(
          newAmount0,
          newAmount1,
          sqrtPriceX64,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        // Check if this is better (accounting for swap costs)
        const swapCost = swapResult.fee + swapResult.slippage;
        const improvement = liquidity - bestResult.liquidity;

        // Force swap if we started with only one token (amount0 was 0)
        // Otherwise require 2x improvement over swap cost
        const shouldSwap =
          amount0 === 0n ||
          (improvement > 0n && Number(improvement) > Number(swapCost) * 2);

        if (shouldSwap) {
          // Calculate amounts used for liquidity position (pure liquidity, no fees)
          const liquidityAmounts = this.calculateAmountsForLiquidity(
            liquidity,
            sqrtPriceX64,
            sqrtPriceLower,
            sqrtPriceUpper
          );

          // APPROACH A: Track ALL tokens separately
          // Accounting invariant for token1→token0 swap:
          //   amount0 = depositedAmount0 + slip0 + remain0
          //   amount1 = depositedAmount1 + swapFee1 + remain1
          //
          // Physical flow:
          //   1. Start with: amount0, amount1
          //   2. Swap: spend swapAmount1 (which includes fee), receive amountOut (reduced by slippage)
          //      - Fee paid: swapResult.fee (from token1)
          //      - Slippage lost: swapResult.slippage (from expected token0 output)
          //   3. After swap: (amount0 + amountOut), (amount1 - swapAmount1)
          //   4. Deposit into liquidity: liquidityAmounts.amount0, liquidityAmounts.amount1
          //   5. Remain: what's physically left
          //
          // Calculate physical remain:
          const actualRemain0 =
            amount0 + swapResult.amountOut - liquidityAmounts.amount0;
          const actualRemain1 =
            amount1 - swapAmount1 - liquidityAmounts.amount1;

          // For token0: amount0 = depositedAmount0 + slip0 + remain0
          // amount0 + amountOut = depositedAmount0 + remain0 (physically)
          // But amountOut = expectedOut - slippage
          // So: amount0 + expectedOut - slippage = depositedAmount0 + remain0
          // We want: amount0 = depositedAmount0 + slippage + remain0
          // Therefore: remain0 = amount0 - depositedAmount0 - slippage
          const remain0 =
            amount0 - liquidityAmounts.amount0 - swapResult.slippage;

          // For token1: amount1 = depositedAmount1 + swapFee1 + remain1
          // Since swapAmount1 = fee + <what gets converted to token0>
          // We have: amount1 = swapAmount1 + actualRemain1 + depositedAmount1
          //                  = fee + <converted> + actualRemain1 + depositedAmount1
          // We want: amount1 = fee + depositedAmount1 + remain1
          // So: remain1 = amount1 - fee - depositedAmount1
          const remain1 = amount1 - swapResult.fee - liquidityAmounts.amount1;

          bestResult = {
            liquidity,
            remain0,
            remain1,
            actualRemain0,
            actualRemain1,
            swapFee0: 0n,
            swapFee1: swapResult.fee, // Fee is paid in input token (token1)
            slip0: swapResult.slippage, // Slippage is lost in output token (token0)
            slip1: 0n,
            depositedAmount0: liquidityAmounts.amount0,
            depositedAmount1: liquidityAmounts.amount1,
          };
        }
      }
    }

    // If no swap was beneficial, calculate remaining amounts for no-swap case
    if (bestResult.swapFee0 === 0n && bestResult.swapFee1 === 0n) {
      const usedAmounts = this.calculateAmountsForLiquidity(
        bestResult.liquidity,
        sqrtPriceX64,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      bestResult.remain0 =
        amount0 > usedAmounts.amount0 ? amount0 - usedAmounts.amount0 : 0n;
      bestResult.remain1 =
        amount1 > usedAmounts.amount1 ? amount1 - usedAmounts.amount1 : 0n;
      bestResult.actualRemain0 = bestResult.remain0;
      bestResult.actualRemain1 = bestResult.remain1;
      bestResult.depositedAmount0 = usedAmounts.amount0;
      bestResult.depositedAmount1 = usedAmounts.amount1;
    }

    return bestResult;
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
  private static simulateSwap(
    amountIn: bigint,
    zeroForOne: boolean,
    currentPrice: number,
    feeRatePpm: number,
    slippageBps: number = 50, // 0.5% default slippage
    decimal: number = 8
  ): { amountOut: bigint; fee: bigint; slippage: bigint } {
    if (amountIn <= 0n) {
      return { amountOut: 0n, fee: 0n, slippage: 0n };
    }

    // Calculate fee
    const fee = (amountIn * BigInt(feeRatePpm)) / 1000000n;
    const amountInAfterFee = amountIn - fee;

    if (amountInAfterFee <= 0n) {
      return { amountOut: 0n, fee, slippage: 0n };
    }

    // Calculate amount out based on current price
    let amountOut: bigint;
    if (zeroForOne) {
      // token0 -> token1: multiply by price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) * currentPrice));
    } else {
      // token1 -> token0: divide by price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) / currentPrice));
    }

    // Calculate slippage (reduce output)
    let slippage: bigint;
    try {
      const tokenAName = process.env.TOKEN_A_NAME || "TokenA";
      const tokenBName = process.env.TOKEN_B_NAME || "TokenB";
      const swapAmount = amountIn / 10n ** BigInt(decimal);
      const maxSlippage = getMaxSlippage(
        tokenAName,
        tokenBName,
        Number(swapAmount)
      );
      if (maxSlippage === null) {
        throw new Error("Swap amount exceeds max slippage threshold");
      }
      // Convert maxSlippage (percentage) to scaled integer for BigInt calculation
      const slippageScaled = Math.floor(maxSlippage * 1e10); // Scale up by 10 billion
      slippage = (amountOut * BigInt(slippageScaled)) / 1000000000000n; // Divide by 1e12 (1e10 * 100)
    } catch (error: any) {
      slippage = (amountOut * BigInt(slippageBps)) / 10000n;
    }

    const amountOutBeforeSlippage = amountOut;
    amountOut = amountOut - slippage;

    if (amountOut < 0n) {
      amountOut = 0n;
    }

    // Log detailed swap simulation for analysis
    const feeRate = (Number(fee) / Number(amountIn)) * 100;
    const slippageRate =
      amountOutBeforeSlippage > 0n
        ? (Number(slippage) / Number(amountOutBeforeSlippage)) * 100
        : 0;

    console.log(
      `[SimulateSwap] ${zeroForOne ? "Token0→Token1" : "Token1→Token0"}: ` +
        `amountIn=${amountIn.toString()}, ` +
        `fee=${fee.toString()} (${feeRate.toFixed(4)}%), ` +
        `amountOut=${amountOut.toString()}, ` +
        `slippage=${slippage.toString()} (${slippageRate.toFixed(4)}%), ` +
        `price=${currentPrice.toFixed(6)}`
    );

    return { amountOut, fee, slippage };
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
