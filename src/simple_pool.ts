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
    const q64Number = Number(SimplePool.Q64);
    const result = sqrtPrice * q64Number;
    
    // Check for overflow/NaN
    if (!isFinite(result) || result < 0) {
      throw new Error(`Invalid sqrt price calculation for tick ${tick}`);
    }
    
    return BigInt(Math.floor(result));
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

    // Get current sqrtPrice - use tick if sqrtPriceX64 is not initialized yet
    let sqrtPriceX64 = this.sqrtPriceX64;
    if (sqrtPriceX64 === 0n) {
      sqrtPriceX64 = this.tickToSqrtPrice(this.tick);
    }
    
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
      // Current price is above range - need to swap token1 to token0
      // But don't swap ALL token1, as price impact might move us out of range
      // Use a conservative approach: estimate the swap amount needed
      if (amount1 > minSwapThreshold) {
        // Estimate token0 needed based on liquidity we can add
        // For price above range: only token0 is used
        // L = amount0 * sqrtPriceUpper * sqrtPriceLower / ((sqrtPriceUpper - sqrtPriceLower) * 2^64)
        const range = sqrtPriceUpper - sqrtPriceLower;
        const liquidityFromToken0 = (amount0 * sqrtPriceUpper * sqrtPriceLower) / (range * SimplePool.Q64);
        
        // Estimate additional token0 from swapping (roughly at current price)
        const currentPrice = this.price();
        const estimatedToken0FromSwap = BigInt(Math.floor(Number(amount1) / currentPrice * 0.99)); // 99% to account for fees/slippage
        const totalPotentialToken0 = amount0 + estimatedToken0FromSwap;
        
        // Calculate max useful liquidity
        const maxUsefulLiquidity = (totalPotentialToken0 * sqrtPriceUpper * sqrtPriceLower) / (range * SimplePool.Q64);
        
        // Calculate token0 needed for max liquidity
        const token0Needed = (maxUsefulLiquidity * range * SimplePool.Q64) / (sqrtPriceUpper * sqrtPriceLower);
        
        if (token0Needed > amount0) {
          // Need to swap some token1
          const token0Gap = token0Needed - amount0;
          // Estimate swap amount (accounting for price impact - be conservative)
          const swapEstimate = BigInt(Math.floor(Number(token0Gap) * currentPrice * 1.01)); // 101% buffer
          swapAmount = swapEstimate > amount1 ? amount1 : swapEstimate;
          
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
      }
    }
    // Case 2: Price range is entirely above current price - only need token1
    else if (sqrtPriceX64 <= sqrtPriceLower) {
      // Current price is below range - need to swap token0 to token1
      // But don't swap ALL token0, as price impact might move us out of range
      // Use a conservative approach: estimate the swap amount needed
      if (amount0 > minSwapThreshold) {
        // Estimate token1 needed based on liquidity we can add
        // For price below range: only token1 is used
        // L = amount1 * 2^64 / (sqrtPriceUpper - sqrtPriceLower)
        const liquidityFromToken1 = (amount1 * SimplePool.Q64) / (sqrtPriceUpper - sqrtPriceLower);
        
        // Estimate additional token1 from swapping (roughly at current price)
        // Be conservative: only swap enough to fill the range at current price
        const currentPrice = this.price();
        const estimatedToken1FromSwap = BigInt(Math.floor(Number(amount0) * currentPrice * 0.99)); // 99% to account for fees/slippage
        const totalPotentialToken1 = amount1 + estimatedToken1FromSwap;
        
        // Calculate max useful liquidity (limited by sqrt price range)
        const maxUsefulLiquidity = (totalPotentialToken1 * SimplePool.Q64) / (sqrtPriceUpper - sqrtPriceLower);
        
        // If we have way more token0 than we can use, swap most of it, otherwise swap conservatively
        const token1Needed = (maxUsefulLiquidity * (sqrtPriceUpper - sqrtPriceLower)) / SimplePool.Q64;
        
        if (token1Needed > amount1) {
          // Need to swap some token0
          const token1Gap = token1Needed - amount1;
          // Estimate swap amount (accounting for price impact - be conservative)
          const swapEstimate = BigInt(Math.floor(Number(token1Gap) / currentPrice * 1.01)); // 101% buffer
          swapAmount = swapEstimate > amount0 ? amount0 : swapEstimate;
          
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

      // Handle edge cases where one token is zero
      if (amount0 === 0n && amount1 > 0n) {
        // Have only token1, need to swap some to token0
        // Swap enough token1 to get the required ratio
        const price = this.price();
        // After swap: amount1_remaining / amount0_received = requiredRatio
        // amount1_remaining = amount1 - swapAmount
        // amount0_received ≈ swapAmount / price (after fees/slippage)
        // So: (amount1 - swapAmount) / (swapAmount / price) = requiredRatio
        // amount1 - swapAmount = requiredRatio * swapAmount / price
        // amount1 = swapAmount * (1 + requiredRatio / price)
        // swapAmount = amount1 / (1 + requiredRatio / price)
        const swapEstimate = Number(amount1) / (1 + requiredRatio / price);
        
        if (swapEstimate > 0) {
          swapAmount = BigInt(Math.floor(swapEstimate));
          if (swapAmount > amount1) swapAmount = amount1;
          
          if (swapAmount > minSwapThreshold) {
            needSwap = true;
            swapDirection = "1to0";
            const swapResult = this.swap(swapAmount, false);
            swapReceived = swapResult.amountOut;
            swapFee = swapResult.fee;
            swapSlippage = swapResult.slippage;
            finalAmount0 = swapResult.amountOut;
            finalAmount1 = amount1 - swapAmount;
          }
        }
      } else if (amount1 === 0n && amount0 > 0n) {
        // Have only token0, need to swap some to token1
        const price = this.price();
        // After swap: amount1_received / amount0_remaining = requiredRatio
        // amount1_received ≈ swapAmount * price (after fees/slippage)
        // amount0_remaining = amount0 - swapAmount
        // So: (swapAmount * price) / (amount0 - swapAmount) = requiredRatio
        // swapAmount * price = requiredRatio * (amount0 - swapAmount)
        // swapAmount * price = requiredRatio * amount0 - requiredRatio * swapAmount
        // swapAmount * (price + requiredRatio) = requiredRatio * amount0
        // swapAmount = (requiredRatio * amount0) / (price + requiredRatio)
        const swapEstimate = (requiredRatio * Number(amount0)) / (price + requiredRatio);
        
        if (swapEstimate > 0) {
          swapAmount = BigInt(Math.floor(swapEstimate));
          if (swapAmount > amount0) swapAmount = amount0;
          
          if (swapAmount > minSwapThreshold) {
            needSwap = true;
            swapDirection = "0to1";
            const swapResult = this.swap(swapAmount, true);
            swapReceived = swapResult.amountOut;
            swapFee = swapResult.fee;
            swapSlippage = swapResult.slippage;
            finalAmount0 = amount0 - swapAmount;
            finalAmount1 = swapResult.amountOut;
          }
        }
      } else if (amount0 > 0n && amount1 > 0n) {
        // Have both tokens - calculate current ratio and adjust
        const currentRatio = Number(amount1) / Number(amount0);

        // Determine if we need to swap and in which direction
        if (currentRatio > requiredRatio * 1.01) {
          // We have too much token1, swap some token1 → token0
          // Use iterative approach to find optimal swap accounting for price impact
          const price = this.price();
          
          // Estimate price impact based on pool liquidity
          const poolLiquidityValue = Number(this.liquidity) / 1e18;
          
          // Binary search for optimal swap amount
          let low = 0n;
          let high = amount1;
          let bestSwap = 0n;
          let bestRatioError = Infinity;
          
          for (let i = 0; i < 10 && high > low; i++) {
            const mid = (low + high) / 2n;
            
            // Estimate output after swap (accounting for fees ~0.3%)
            const estimatedOut = (mid * 997n) / BigInt(Math.floor(price * 1000));
            
            // Estimate price impact
            const priceImpactFactor = poolLiquidityValue > 0 
              ? Math.max(0.95, 1 - Number(mid) / poolLiquidityValue / 10)
              : 0.98;
            const actualOut = BigInt(Math.floor(Number(estimatedOut) * priceImpactFactor));
            
            // Check resulting ratio
            const resultAmount0 = amount0 + actualOut;
            const resultAmount1 = amount1 - mid;
            const resultRatio = Number(resultAmount1) / Number(resultAmount0);
            const ratioError = Math.abs(resultRatio - requiredRatio) / requiredRatio;
            
            if (ratioError < bestRatioError) {
              bestRatioError = ratioError;
              bestSwap = mid;
            }
            
            // Adjust search range
            if (resultRatio > requiredRatio) {
              // Still have too much token1, swap more
              low = mid + 1n;
            } else {
              // Have too little token1, swap less
              high = mid - 1n;
            }
            
            // If we found a good ratio (within 5% error), stop
            if (ratioError < 0.05) break;
          }
          
          swapAmount = bestSwap;

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
        } else if (currentRatio < requiredRatio * 0.99) {
          // We have too much token0, swap some token0 → token1
          // Use iterative approach to find optimal swap accounting for price impact
          const price = this.price();
          
          // Estimate price impact based on pool liquidity
          // Price impact ≈ swapAmount / poolLiquidity
          // For Uniswap V3: ΔP/P ≈ Δx / L (simplified)
          const poolLiquidityValue = Number(this.liquidity) / 1e18; // Rough estimate
          
          // Target: find swap amount such that after swap, we have the right ratio
          // Use binary search to find optimal swap amount
          let low = 0n;
          let high = amount0;
          let bestSwap = 0n;
          let bestRatioError = Infinity;
          
          // Try up to 10 iterations to find good swap amount
          for (let i = 0; i < 10 && high > low; i++) {
            const mid = (low + high) / 2n;
            
            // Estimate output after swap (accounting for fees ~0.3%)
            const estimatedOut = (mid * BigInt(Math.floor(price * 997))) / 1000n;
            
            // Estimate price impact (simplified)
            const priceImpactFactor = poolLiquidityValue > 0 
              ? Math.max(0.95, 1 - Number(mid) / poolLiquidityValue / 10)
              : 0.98;
            const actualOut = BigInt(Math.floor(Number(estimatedOut) * priceImpactFactor));
            
            // Check resulting ratio
            const resultAmount0 = amount0 - mid;
            const resultAmount1 = amount1 + actualOut;
            const resultRatio = Number(resultAmount1) / Number(resultAmount0);
            const ratioError = Math.abs(resultRatio - requiredRatio) / requiredRatio;
            
            if (ratioError < bestRatioError) {
              bestRatioError = ratioError;
              bestSwap = mid;
            }
            
            // Adjust search range
            if (resultRatio < requiredRatio) {
              // Need more token1, swap more token0
              low = mid + 1n;
            } else {
              // Have too much token1, swap less token0
              high = mid - 1n;
            }
            
            // If we found a good ratio (within 5% error), stop
            if (ratioError < 0.05) break;
          }
          
          swapAmount = bestSwap;

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
      // else: both are zero or ratio is close enough, no swap needed
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
    
    // Calculate liquidity from swap data (priceBefore, priceAfter, amountIn, amountOut)
    // This is more accurate than evt.liquidity which only represents current liquidity
    const estimatedLiquidity = this.estimateLiquidityFromSwap(evt);
    
    // Use estimated liquidity from the actual swap impact
    // Don't use evt.liquidity as it only represents the liquidity at that tick, not total pool liquidity
    this.liquidity = estimatedLiquidity;
    
    // Update slippage provider with the pool's calculated liquidity
    this.slipMrg.setPoolLiquidity(this.liquidity);
    
    this.sqrtPriceX64 = evt.sqrtPriceAfter;
    this.tick = evt.tick;
    this.reserve0 = evt.reserveA;
    this.reserve1 = evt.reserveB;
  }

  /**
   * Estimate pool liquidity from swap impact
   * Uses the CLMM formula: L = Δy / Δ(√P) or L = Δx / Δ(1/√P)
   * 
   * For Uniswap V3 concentrated liquidity:
   * - When swapping token0→token1: L = Δy / (√P_after - √P_before)
   * - When swapping token1→token0: L = Δx * √P_before * √P_after / (√P_before - √P_after)
   * 
   * Uses amountIn (before fees) for calculation as it's more accurate
   */
  private estimateLiquidityFromSwap(evt: SwapEvent): bigint {
    // If no price change, can't estimate (return evt.liquidity as fallback)
    if (evt.sqrtPriceBefore === evt.sqrtPriceAfter) {
      return evt.liquidity;
    }

    // Calculate price change
    const sqrtPriceBefore = Number(evt.sqrtPriceBefore);
    const sqrtPriceAfter = Number(evt.sqrtPriceAfter);
    
    if (sqrtPriceBefore === 0 || sqrtPriceAfter === 0) {
      return evt.liquidity;
    }

    // Calculate liquidity based on swap direction
    let estimatedL: number;

    if (evt.zeroForOne) {
      // Swapping token0 for token1
      // amountIn is in token0 (before fee), amountOut is in token1
      // For token1 output: L = Δy / (√P_after - √P_before)
      const deltaY = Number(evt.amountOut);
      const deltaSqrtP = sqrtPriceAfter - sqrtPriceBefore;
      
      if (Math.abs(deltaSqrtP) < 0.0001) {
        return evt.liquidity; // Price change too small to estimate
      }
      
      // L = Δy / Δ(√P) * 2^64 (adjust for Q64.64 format)
      estimatedL = (deltaY / deltaSqrtP) * Number(SimplePool.Q64);
    } else {
      // Swapping token1 for token0
      // amountIn is in token1 (before fee), amountOut is in token0
      // For token0 output: L = Δx / Δ(1/√P)
      const deltaX = Number(evt.amountOut);
      const deltaSqrtPInverse = (1 / sqrtPriceAfter) - (1 / sqrtPriceBefore);
      
      if (Math.abs(deltaSqrtPInverse) < 0.000001) {
        return evt.liquidity; // Price change too small to estimate
      }
      
      // L = Δx / Δ(1/√P) * 2^64
      estimatedL = (deltaX / deltaSqrtPInverse) * Number(SimplePool.Q64);
    }

    // Convert to bigint and ensure positive
    if (!isFinite(estimatedL) || estimatedL <= 0) {
      return evt.liquidity;
    }

    return BigInt(Math.floor(Math.abs(estimatedL)));
  }

  price(): number {
    // Use sqrtPriceX64 if available, otherwise derive from tick
    let sqrtPriceX64 = this.sqrtPriceX64;
    if (sqrtPriceX64 === 0n) {
      sqrtPriceX64 = this.tickToSqrtPrice(this.tick);
    }
    const sqrtPrice = Number(sqrtPriceX64) / Number(SimplePool.Q64);
    return sqrtPrice * sqrtPrice;
  }

  getTick(): number {
    return this.tick;
  }
}
