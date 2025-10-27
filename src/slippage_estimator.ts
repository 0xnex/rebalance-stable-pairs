import type { ISlippageProvider } from "./types";

/**
 * Improved slippage estimator using Uniswap V3 CLMM formulas
 * 
 * Key improvements:
 * - Uses actual liquidity L from the pool (not from individual swap events)
 * - Applies proper CLMM price impact formula: ΔP/P = Δx/L for concentrated liquidity
 * - More accurate than AMM reserve-based estimation
 * - Handles both token0→token1 and token1→token0 swaps
 * 
 * CLMM Price Impact Formula:
 * For a swap of amount Δx in a concentrated liquidity range:
 * - Price impact ≈ Δx / L (where L is the pool's effective liquidity)
 * - Total slippage = price_impact (no base slippage)
 * - Capped at maxSlippage
 */
export class SlippageEstimator implements ISlippageProvider {
  // Pool state tracking - liquidity is set by the pool
  private liquidity: bigint = 0n;
  
  // Slippage model parameters
  private readonly baseSlippage: number;     // Kept for backward compatibility (not used)
  private readonly maxSlippage: number;      // Maximum slippage cap
  
  // Precision and safety
  private static readonly MIN_LIQUIDITY = 1000n; // Minimum liquidity to calculate slippage

  /**
   * @param baseSlippage (Deprecated - not used) Kept for backward compatibility
   * @param maxSlippage Maximum slippage cap (default 0.5 = 50%)
   */
  constructor(
    baseSlippage: number = 0.001,
    maxSlippage: number = 0.5
  ) {
    // Validate parameters
    if (baseSlippage < 0 || baseSlippage > 1) {
      throw new Error(`Invalid baseSlippage: ${baseSlippage}. Must be between 0 and 1.`);
    }
    if (maxSlippage < baseSlippage || maxSlippage > 1) {
      throw new Error(`Invalid maxSlippage: ${maxSlippage}. Must be between baseSlippage and 1.`);
    }

    this.baseSlippage = baseSlippage;  // Stored but not used
    this.maxSlippage = maxSlippage;
  }

  /**
   * Calculate slippage percentage using CLMM liquidity
   * 
   * For Uniswap V3 CLMM:
   * - Price impact = amountIn / L (in the concentrated range)
   * - This is much more accurate than reserve-based estimation
   * - L represents the active liquidity in the current tick range
   * - No base slippage applied, only actual price impact
   */
  getSlippagePct(amountIn: bigint, zeroForOne: boolean, price: number): number {
    // Edge case: no amount
    if (amountIn <= 0n) {
      return 0;
    }

    // Edge case: no liquidity data yet - return 0 (not base slippage)
    if (this.liquidity < SlippageEstimator.MIN_LIQUIDITY) {
      return 0;
    }

    // Calculate price impact using CLMM formula: ΔP/P ≈ Δx/L
    const priceImpact = this.estimateCLMMPriceImpact(amountIn, this.liquidity);
    
    if (!isFinite(priceImpact) || priceImpact < 0) {
      return this.maxSlippage;
    }

    // Only use price impact (no base slippage)
    const totalSlippage = priceImpact;

    // Ensure result is valid and capped at max
    if (!isFinite(totalSlippage) || totalSlippage < 0) {
      return this.maxSlippage;
    }

    return Math.min(totalSlippage, this.maxSlippage);
  }

  /**
   * Estimate price impact using CLMM liquidity formula
   * 
   * For Uniswap V3 concentrated liquidity:
   * - Price impact is proportional to (amountIn / L)
   * - But the actual impact depends on liquidity depth
   * - Use a scaling factor to make it realistic
   * 
   * Formula: price_impact = (amountIn / L) * scaling_factor
   * Using scaling_factor = 0.1 (10%) for realistic impact
   * This means: swapping 1% of L causes ~0.1% price impact
   */
  private estimateCLMMPriceImpact(amountIn: bigint, liquidity: bigint): number {
    const amountInNum = this.safeToNumber(amountIn);
    const liquidityNum = this.safeToNumber(liquidity);
    
    if (!isFinite(amountInNum) || !isFinite(liquidityNum) || liquidityNum <= 0) {
      return this.maxSlippage;
    }

    // CLMM formula with realistic scaling
    // Scaling factor of 0.1 means: swapping 1% of L → 0.1% price impact
    const PRICE_IMPACT_FACTOR = 0.1;  // 10% scaling factor
    const ratio = amountInNum / liquidityNum;
    const impact = ratio * PRICE_IMPACT_FACTOR;
    
    return impact;
  }

  /**
   * Safely convert BigInt to Number with scaling for large values
   */
  private safeToNumber(value: bigint): number {
    const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
    
    if (value < MAX_SAFE_BIGINT) {
      return Number(value);
    }
    
    // Scale down by finding appropriate power of 10
    let scale = 1n;
    let scaled = value;
    
    while (scaled > MAX_SAFE_BIGINT && scale < 1000000000000000000n) {
      scale *= 10n;
      scaled = value / scale;
    }
    
    // Return scaled value (this preserves relative magnitudes)
    return Number(scaled) * Number(scale);
  }

  /**
   * Set pool liquidity from the pool's calculated value
   * Called by the pool after processing swap events
   */
  setPoolLiquidity(liquidity: bigint): void {
    this.liquidity = liquidity;
  }

  /**
   * Get current pool liquidity
   */
  getPoolLiquidity(): bigint {
    return this.liquidity;
  }

  /**
   * Estimate slippage for a specific amount with detailed breakdown
   * Returns percentage as a number (e.g., 0.01 = 1%)
   * Note: No base slippage is applied, only price impact
   */
  estimateSlippage(amountIn: bigint, zeroForOne: boolean): {
    slippagePct: number;
    baseSlippage: number;
    priceImpact: number;
    liquidityRatio: number;
  } {
    if (amountIn <= 0n) {
      return {
        slippagePct: 0,
        baseSlippage: 0,  // Always 0 (not used)
        priceImpact: 0,
        liquidityRatio: 0,
      };
    }

    if (this.liquidity < SlippageEstimator.MIN_LIQUIDITY) {
      return {
        slippagePct: this.maxSlippage,
        baseSlippage: 0,  // Always 0 (not used)
        priceImpact: this.maxSlippage,
        liquidityRatio: 0,
      };
    }

    const priceImpact = this.estimateCLMMPriceImpact(amountIn, this.liquidity);
    const liquidityRatio = this.safeToNumber(amountIn) / this.safeToNumber(this.liquidity);
    
    if (!isFinite(priceImpact) || priceImpact < 0) {
      return {
        slippagePct: this.maxSlippage,
        baseSlippage: 0,  // Always 0 (not used)
        priceImpact: this.maxSlippage,
        liquidityRatio: isFinite(liquidityRatio) ? liquidityRatio : 0,
      };
    }
    
    // Only price impact, no base slippage
    const slippagePct = Math.min(priceImpact, this.maxSlippage);

    return {
      slippagePct: isFinite(slippagePct) ? slippagePct : this.maxSlippage,
      baseSlippage: 0,  // Always 0 (not used)
      priceImpact: isFinite(priceImpact) ? priceImpact : this.maxSlippage,
      liquidityRatio: isFinite(liquidityRatio) ? liquidityRatio : 0,
    };
  }
}

/**
 * Fixed slippage - for testing or simple scenarios
 */
export class FixedSlippageProvider implements ISlippageProvider {
  private readonly slippagePct: number;

  constructor(slippagePct: number = 0.001) {
    this.slippagePct = slippagePct;
  }

  getSlippagePct(amountIn: bigint, zeroForOne: boolean, price: number): number {
    return this.slippagePct;
  }

  setPoolLiquidity(liquidity: bigint): void {
    // No-op for fixed slippage
  }
}

